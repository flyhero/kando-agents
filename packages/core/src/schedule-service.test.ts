import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Task, type AgentKind, type AgentUsage, type ChatItem, type Routine, type ScheduledRun, type ScheduleTaskBlocker, type UnattendedMode } from '@kando/protocol'
import { CONTINUE_TEXT, SCHEDULED_GO_TEXT, UNATTENDED_NOTE } from './agent-prompt'
import { AttachmentStore } from './attachment-store'
import { pngBytes } from './image-fixtures'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { ScheduleService } from './schedule-service'
import { UsageLimitResumes } from './usage-limit-resume'
import { TaskStore } from './task-store'

const HOUR = 3_600_000

const pendingTask = (): Task => Task.parse({
  id: 'task-1', title: 'Dark mode', details: '', status: 'pending', repos: [], dependsOn: [], agent: 'claude', createdAt: 0, updatedAt: 0
})

describe('ScheduleService', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let schedules: ScheduleService
  let clock: number
  let usage: AgentUsage[]
  let mode: UnattendedMode
  let announced: ScheduledRun[]
  // The task the fake task service knows, how its start goes, and the starts asked of it.
  let task: Task | null
  let blocker: ScheduleTaskBlocker | null
  let startFails: Error | null
  let starts: Array<{ id: string; unattended: UnattendedMode }>
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  let limits: UsageLimitResumes
  let emitted: ChatItem[]
  // The one routine the fake routine service knows, the agent it picks for 'auto', and the runs
  // it heard of.
  let routine: Routine | null
  let picked: AgentKind
  let heard: ScheduledRun[]

  function serve(): void {
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (event) => { if (event.type === 'chatItems') limits.observe(event.conversationId, event.items) },
      projects, attachments())
    const target = conversations
    daemon.deliver = (event) => {
      if (event.event === 'data') target.handleData(event)
      else if (event.event === 'exit') target.handleExit(event.sessionId, event.exitCode)
      else target.handleStderr(event.sessionId, event.data)
    }
    schedules = new ScheduleService(database, {
      tasks: {
        get: (id) => (task?.id === id ? task : null),
        scheduleBlocker: () => blocker,
        start: async (id, _allowBypass, unattended) => {
          starts.push({ id, unattended })
          if (startFails) throw startFails
          const started: Task = { ...pendingTask(), status: 'running', conversationId: 'chat-of-task' }
          task = started
          return started
        },
        resumeChat: async () => pendingTask()
      },
      conversations,
      usage: { list: () => usage, refresh: async () => usage },
      mode: () => mode,
      emit: (runs) => { announced = runs },
      limitChanged: (conversationId, limit) => limits.announce(conversationId, limit),
      routines: {
        pass: async () => {},
        get: (id) => (routine?.id === id ? routine : null),
        pickAgent: () => picked,
        runChanged: (changed) => { heard.push(changed) }
      }
    }, () => clock)
    limits = new UsageLimitResumes(schedules, conversations, { list: () => usage }, (_conversationId, items) => emitted.push(...items), () => clock)
  }

  // The first `turns` messages Claude Code gets run into the five-hour limit; later ones go through.
  function limitTurns(turns: number, resetsAt: number | null): void {
    const answer = daemon.reply
    let left = turns
    daemon.reply = (sessionId, text) => {
      if (left <= 0) return answer(sessionId, text)
      left -= 1
      if (resetsAt !== null) daemon.emit(sessionId, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAt / 1000 } })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", duration_ms: 20 })
    }
  }

  async function limitedChat(resetsAt: number | null = clock + HOUR) {
    limitTurns(1, resetsAt)
    const conversation = await conversations.create('claude', [])
    await conversations.send(conversation.id, 'refactor the payments module')
    await settle()
    const item = conversations.chatPage(conversation.id).items.find((each) => each.kind === 'usageLimit')
    if (!item) throw new Error('no usage limit item')
    return { id: conversation.id, item }
  }

  const statusOf = (item: ChatItem) => {
    const [decorated] = limits.decorate([item])
    return decorated?.kind === 'usageLimit' ? decorated : null
  }
  const continues = (id: string) => userTexts(id).filter((text) => text === CONTINUE_TEXT)
  const modeSwitches = (id: string) => daemon.written(conversations.get(id).sessionId ?? '').filter((frame) => JSON.stringify(frame).includes('set_permission_mode'))

  function attachments(): AttachmentStore {
    const dir = path.join(root, 'attachments')
    mkdirSync(dir, { recursive: true })
    return new AttachmentStore(dir)
  }

  function exhausted(resetsAt: number | null): AgentUsage[] {
    return [{ agent: 'claude', status: 'ok', plan: null, error: null, updatedAt: clock, resetCredits: null,
      windows: [{ kind: 'session', model: null, usedPercent: 100, windowMinutes: 300, resetsAt }] }]
  }

  // Ticks, then lets the started agent answer.
  async function due(): Promise<void> {
    await schedules.tick()
    await settle()
  }

  const userTexts = (id: string) => conversations.chatPage(id).items.flatMap((item) => (item.kind === 'user' ? [item.text] : []))
  const run = (id: string) => schedules.list().find((each) => each.id === id)

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-schedule-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    clock = Date.now()
    usage = []
    mode = 'acceptEdits'
    announced = []
    emitted = []
    task = null
    blocker = null
    startFails = null
    starts = []
    routine = null
    picked = 'claude'
    heard = []
    serve()
  })

  afterEach(() => {
    schedules.stop()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects Cursor scheduling and rechecks a target whose agent changed before dispatch', async () => {
    task = { ...pendingTask(), agent: 'cursor' }
    expect(() => schedules.create({ kind: 'task', taskId: task!.id }, clock + HOUR)).toThrow(expect.objectContaining({ reason: 'cursor-unattended-unsupported' }))
    task = pendingTask()
    const scheduled = schedules.create({ kind: 'task', taskId: task.id }, clock + HOUR)
    task = { ...task, agent: 'cursor' }
    clock += HOUR
    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'failed', error: 'cursor-unattended-unsupported' })
    expect(starts).toEqual([])
  })

  it('sends a conversation\'s message once its time has come and the quota has reset, unattended', async () => {
    const conversation = await conversations.create('claude', [])
    const resetsAt = clock + 2 * HOUR
    usage = exhausted(resetsAt)
    const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: 'Implement the plan' }, clock + HOUR)
    expect(scheduled).toMatchObject({ status: 'waiting', title: '新会话', agent: 'claude', notBefore: clock + HOUR })
    expect(announced.map((each) => each.id)).toEqual([scheduled.id])

    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'waiting', resetsAt: null })
    clock += HOUR
    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'waiting', resetsAt })
    expect(userTexts(conversation.id)).toEqual([])

    usage = []
    clock = resetsAt + 5_000
    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'started', conversationId: conversation.id, settledAt: clock })
    expect(userTexts(conversation.id)).toEqual([`${UNATTENDED_NOTE}\n\nImplement the plan`])
    expect(daemon.written(conversations.get(conversation.id).sessionId ?? '')).toEqual(expect.arrayContaining([
      expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } })
    ]))

    await due()
    expect(userTexts(conversation.id)).toHaveLength(1)
  })

  it('sends the pictures a message was scheduled with, and pictures alone as they are', async () => {
    const image = (await new AttachmentStore(path.join(root, 'attachments')).put(pngBytes(4, 3))).id
    const conversation = await conversations.create('claude', [])
    schedules.create({ kind: 'conversation', conversationId: conversation.id, text: 'What is wrong here?', images: [image] }, null)
    await due()
    const pictures = () => conversations.chatPage(conversation.id).items.flatMap((item) => (item.kind === 'user' ? [item.images.map((each) => each.id)] : []))
    expect(userTexts(conversation.id)).toEqual([`${UNATTENDED_NOTE}\n\nWhat is wrong here?`])
    expect(pictures()).toEqual([[image]])

    const alone = await conversations.create('claude', [])
    schedules.create({ kind: 'conversation', conversationId: alone.id, text: '', images: [image] }, null)
    await due()
    // Not the go-ahead to carry out a plan: the pictures are the message.
    expect(userTexts(alone.id)).toEqual([UNATTENDED_NOTE])
  })

  it('starts a released agent again in the unattended mode, and goes on with its plan when told nothing more', async () => {
    const conversation = await conversations.create('claude', [])
    await conversations.stop(conversation.id)
    mode = 'bypass'
    const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: '' }, null)
    await due()
    expect(run(scheduled.id)?.status).toBe('started')
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    expect(userTexts(conversation.id)).toEqual([`${UNATTENDED_NOTE}\n\n${SCHEDULED_GO_TEXT}`])
  })

  it('approves a plan the agent waits on, rather than sending into its turn', async () => {
    const conversation = await conversations.create('claude', [])
    const sessionId = conversations.get(conversation.id).sessionId ?? ''
    daemon.reply = (id) => daemon.emit(id, {
      type: 'control_request', request_id: 'plan-1',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: 'toolu_plan-1' }
    })
    await conversations.send(conversation.id, 'Plan the refactor')
    await settle()
    expect(conversations.get(conversation.id).chat?.turn).toBe('awaiting')

    const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: '' }, null)
    await due()
    expect(run(scheduled.id)?.status).toBe('started')
    expect(daemon.written(sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'control_response', response: expect.objectContaining({ request_id: 'plan-1' }) })
    ]))
    expect(userTexts(conversation.id)).toEqual(['Plan the refactor'])
  })

  it('goes one run per agent at a time, in the order the user put them', async () => {
    const first = await conversations.create('claude', [])
    const second = await conversations.create('claude', [])
    // The first run's turn keeps going until the test ends it.
    const answer = daemon.reply
    daemon.reply = () => {}
    const a = schedules.create({ kind: 'conversation', conversationId: first.id, text: 'first' }, clock + HOUR)
    const b = schedules.create({ kind: 'conversation', conversationId: second.id, text: 'second' }, clock + HOUR)
    schedules.reorder([b.id, a.id])
    expect(schedules.list().map((each) => each.id)).toEqual([b.id, a.id])

    clock += HOUR
    await due()
    expect(run(b.id)?.status).toBe('started')
    expect(run(a.id)?.status).toBe('waiting')
    await due()
    expect(run(a.id)?.status).toBe('waiting')

    daemon.reply = answer
    const sessionId = conversations.get(second.id).sessionId ?? ''
    daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: false, result: 'done', terminal_reason: 'completed', duration_ms: 5 })
    await due()
    expect(run(a.id)?.status).toBe('started')
  })

  it('starts a task carried out unattended, and drops it once the task is started by hand or deleted', async () => {
    task = pendingTask()
    blocker = 'dependencies-unfinished'
    expect(() => schedules.create({ kind: 'task', taskId: 'task-1' }, null)).toThrow(expect.objectContaining({ reason: 'dependencies-unfinished' }))
    blocker = null
    const scheduled = schedules.create({ kind: 'task', taskId: 'task-1' }, clock + HOUR)
    expect(() => schedules.create({ kind: 'task', taskId: 'task-1' }, null)).toThrow(expect.objectContaining({ reason: 'already-scheduled' }))

    mode = 'bypass'
    expect(await schedules.runNow(scheduled.id)).toMatchObject({ status: 'started', conversationId: 'chat-of-task' })
    expect(starts).toEqual([{ id: 'task-1', unattended: 'bypass' }])

    task = pendingTask()
    const again = schedules.create({ kind: 'task', taskId: 'task-1' }, clock + HOUR)
    schedules.taskChanged({ id: 'task-1', status: 'running', conversationId: null })
    expect(run(again.id)).toMatchObject({ status: 'cancelled', error: 'task-started' })
    const third = schedules.create({ kind: 'task', taskId: 'task-1' }, clock + HOUR)
    schedules.taskDeleted('task-1')
    expect(run(third.id)).toMatchObject({ status: 'cancelled', error: 'task-not-found' })
  })

  it('tries again after a start that failed, and gives up on one its rules refuse', async () => {
    task = pendingTask()
    const scheduled = schedules.create({ kind: 'task', taskId: 'task-1' }, clock + HOUR)
    clock += HOUR
    startFails = new Error('spawn failed')
    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'waiting', attempts: 1, error: 'spawn failed' })
    await due()
    expect(starts).toHaveLength(1)

    clock += 60_000
    startFails = new Rejection('missing-repo')
    await due()
    expect(run(scheduled.id)).toMatchObject({ status: 'failed', attempts: 2, error: 'missing-repo' })
    schedules.clear()
    expect(schedules.list()).toEqual([])
  })

  it('keeps a capacity-blocked run queued without using retry attempts and starts when a slot opens', async () => {
    conversations.setCapacity({ maxConcurrentAgents: 1, agentConcurrency: { claude: 1 } }, () => { void schedules.tick() })
    const live = await conversations.create('claude', [])
    task = pendingTask()
    const queued = schedules.create({ kind: 'task', taskId: 'task-1' }, null)
    await due()
    expect(run(queued.id)).toMatchObject({ status: 'waiting', attempts: 0 })
    expect(starts).toHaveLength(0)

    daemon.exit(live.sessionId!, 0)
    await due()
    expect(run(queued.id)).toMatchObject({ status: 'started', attempts: 0 })
    expect(starts).toHaveLength(1)
  })

  it('does not exhaust retries if capacity becomes full between admission and launch', async () => {
    task = pendingTask()
    startFails = new Rejection('agent-capacity')
    const queued = schedules.create({ kind: 'task', taskId: 'task-1' }, null)
    await due()
    expect(run(queued.id)).toMatchObject({ status: 'waiting', attempts: 0, error: 'agent-capacity' })
    clock += 60_000
    startFails = null
    await due()
    expect(run(queued.id)).toMatchObject({ status: 'started', attempts: 0 })
  })

  it('takes a start core was making when it stopped as made, once its message went out', async () => {
    const conversation = await conversations.create('claude', [])
    const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: 'go' }, clock + HOUR)
    await conversations.send(conversation.id, 'go', [], false, false, `schedule:${scheduled.id}`)
    await settle()
    const raw = new DatabaseSync(database)
    raw.prepare("UPDATE scheduled_runs SET status = 'starting' WHERE id = ?").run(scheduled.id)
    raw.close()
    schedules.stop()
    serve()
    schedules.start()
    expect(run(scheduled.id)).toMatchObject({ status: 'started', conversationId: conversation.id })
    expect(schedules.openCount()).toBe(0)
  })

  it('lets the user edit, cancel and run a waiting run, and not one that is settled', async () => {
    const conversation = await conversations.create('claude', [])
    const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: 'first draft' }, clock + HOUR)
    expect(schedules.update(scheduled.id, { text: 'second draft', notBefore: clock + 2 * HOUR }))
      .toMatchObject({ target: { text: 'second draft' }, notBefore: clock + 2 * HOUR })
    expect(schedules.openCount()).toBe(1)
    expect(schedules.cancel(scheduled.id)).toMatchObject({ status: 'cancelled' })
    expect(() => schedules.cancel(scheduled.id)).toThrow(expect.objectContaining({ reason: 'schedule-settled' }))
    await expect(schedules.runNow(scheduled.id)).rejects.toMatchObject({ reason: 'schedule-settled' })
    expect(schedules.openCount()).toBe(0)
  })

  describe('resuming after a usage limit', () => {
    it('schedules a resume ahead of the queue, and resumes once the limit lifts, keeping the mode', async () => {
      const resetsAt = clock + HOUR
      const { id, item } = await limitedChat(resetsAt)
      const [run] = schedules.list()
      expect(run).toMatchObject({ target: { kind: 'resume', conversationId: id, stageId: item.stageId, itemId: item.id }, status: 'waiting', notBefore: resetsAt + 5_000 })
      expect(statusOf(item)).toMatchObject({ status: 'waiting', autoContinue: true, resetsAt, continueAt: resetsAt + 5_000, runId: run?.id })

      await due()
      expect(continues(id)).toHaveLength(0)
      clock = resetsAt + 5_000
      await due()
      expect(continues(id)).toHaveLength(1)
      expect(modeSwitches(id)).toEqual([])
      expect(userTexts(id).at(-1)).not.toContain(UNATTENDED_NOTE)
      expect(statusOf(item)).toMatchObject({ status: 'continued', continuedAt: clock, continueAt: null })
      expect(emitted.at(-1)).toMatchObject({ kind: 'usageLimit', status: 'continued' })

      clock += HOUR
      await due()
      expect(continues(id)).toHaveLength(1)
    })

    it('goes on in a new stage when the agent was released meanwhile, resuming its session', async () => {
      const { id, item } = await limitedChat()
      await conversations.releaseIdle(Date.now() + 31 * 60_000)
      expect(conversations.get(id).sessionId).toBeNull()
      clock += 2 * HOUR
      await due()
      expect(conversations.get(id).sessionId).not.toBeNull()
      expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume']))
      expect(continues(id)).toHaveLength(1)
      expect(statusOf(item)?.status).toBe('continued')
    })

    it('waits on when the fresh reading says the limit has not lifted, and learns the reset from it when the agent did not say', async () => {
      const { id, item } = await limitedChat()
      const later = clock + 3 * HOUR
      usage = exhausted(later)
      clock += 2 * HOUR
      await due()
      expect(continues(id)).toHaveLength(0)
      expect(statusOf(item)).toMatchObject({ status: 'waiting', resetsAt: later, continueAt: later + 5_000 })

      clock = Date.now()
      usage = exhausted(clock + HOUR)
      const second = await limitedChat(null)
      expect(statusOf(second.item)).toMatchObject({ resetsAt: clock + HOUR, continueAt: clock + HOUR + 5_000 })
    })

    it('stays put once the user goes on another way, or turns it off; checking again makes a new resume', async () => {
      const first = await limitedChat()
      // A limit the user's own message ran into, while it was being sent, stays.
      limits.cancelFor(first.id, clock - 1)
      expect(statusOf(first.item)?.status).toBe('waiting')
      limits.cancelFor(first.id, clock + 1)
      clock += 2 * HOUR
      await due()
      expect(continues(first.id)).toHaveLength(0)
      expect(statusOf(first.item)).toMatchObject({ status: 'cancelled', autoContinue: false })
      limits.setAutoContinue(first.id, first.item.stageId, first.item.id, true)
      expect(statusOf(first.item)).toMatchObject({ status: 'waiting', autoContinue: true })
      await due()
      expect(continues(first.id)).toHaveLength(1)

      clock = Date.now()
      const second = await limitedChat(clock + HOUR)
      limits.setAutoContinue(second.id, second.item.stageId, second.item.id, false)
      clock += 2 * HOUR
      await due()
      expect(continues(second.id)).toHaveLength(0)
      // Unchecked, the card stays for the user to check again or retry.
      expect(statusOf(second.item)).toMatchObject({ status: 'waiting', autoContinue: false, continueAt: null })
      expect(schedules.openCount()).toBe(0)
    })

    it('lets one retry through at a time, and continues at once without waiting for the reset', async () => {
      const { id, item } = await limitedChat()
      const [first, second] = await Promise.allSettled([
        limits.retry(id, item.stageId, item.id),
        limits.retry(id, item.stageId, item.id)
      ])
      expect(first.status).toBe('fulfilled')
      expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ reason: 'usage-limit-busy' }) })
      await settle()
      expect(continues(id)).toHaveLength(1)
      await expect(limits.retry(id, item.stageId, item.id)).rejects.toMatchObject({ reason: 'usage-limit-settled' })
    })

    it('does not send again for a try that went out before core stopped, under either name', async () => {
      const { id, item } = await limitedChat()
      const [run] = schedules.list()
      await conversations.send(id, CONTINUE_TEXT, [], false, false, `usage-limit:${run?.id}`)
      await settle()
      const raw = new DatabaseSync(database)
      raw.prepare("UPDATE scheduled_runs SET status = 'starting'").run()
      raw.close()
      schedules.stop()
      serve()
      schedules.start()
      expect(statusOf(item)?.status).toBe('continued')
      expect(continues(id)).toHaveLength(1)
    })

    it('only shows a limit a replayed log brings back from before it was seen', async () => {
      const { id, item } = await limitedChat()
      const old = { ...item, id: 'limit:old', at: clock - HOUR }
      limits.observe(id, [old])
      expect(schedules.openCount()).toBe(1)
      expect(statusOf(old)).toMatchObject({ status: 'cancelled', autoContinue: false, runId: null })
      expect(statusOf({ ...item, id: 'limit:unknown' })).toMatchObject({ status: 'cancelled', autoContinue: false, continueAt: null })
    })

    it('drops the resume of a task chat whose task is no longer worked on, and of a chat handed to the other agent', async () => {
      const first = await limitedChat()
      schedules.taskChanged({ id: 'task-9', status: 'review', conversationId: first.id })
      expect(statusOf(first.item)?.status).toBe('cancelled')
      clock = Date.now()
      const second = await limitedChat()
      schedules.conversationChanged({ id: second.id, agent: 'codex' })
      expect(statusOf(second.item)?.status).toBe('cancelled')
      expect(schedules.openCount()).toBe(0)
    })

    it('lets a run the user scheduled take a limit over, continuing the stopped turn in its words', async () => {
      limitTurns(1, clock + HOUR)
      const conversation = await conversations.create('claude', [])
      const scheduled = schedules.create({ kind: 'conversation', conversationId: conversation.id, text: '' }, clock + 2 * HOUR)
      await conversations.send(conversation.id, 'refactor the payments module')
      await settle()
      const item = conversations.chatPage(conversation.id).items.find((each) => each.kind === 'usageLimit')
      expect(schedules.list().filter((run) => run.status === 'waiting')).toHaveLength(1)
      expect(run(scheduled.id)?.target).toMatchObject({ kind: 'conversation', resumes: { stageId: item?.stageId, itemId: item?.id } })
      expect(item && statusOf(item)).toMatchObject({ status: 'waiting', autoContinue: true, continueAt: clock + 2 * HOUR, runId: scheduled.id })

      clock += 2 * HOUR
      await due()
      expect(userTexts(conversation.id)).toEqual(['refactor the payments module', `${UNATTENDED_NOTE}\n\n${CONTINUE_TEXT}`])
      expect(item && statusOf(item)?.status).toBe('continued')
    })

    it('turns a waiting resume into the run the user schedules on that chat, under the same id', async () => {
      const { id, item } = await limitedChat()
      const [resume] = schedules.list()
      const converted = schedules.create({ kind: 'conversation', conversationId: id, text: 'and then run the tests' }, null)
      expect(converted.id).toBe(resume?.id)
      expect(converted.target).toMatchObject({ kind: 'conversation', text: 'and then run the tests', resumes: { stageId: item.stageId, itemId: item.id } })
      expect(schedules.list()).toHaveLength(1)

      await due()
      expect(userTexts(id)).toEqual(['refactor the payments module', `${UNATTENDED_NOTE}\n\nand then run the tests`])
      expect(statusOf(item)?.status).toBe('continued')
    })

    it('resumes before a run the user scheduled that is due at the same time', async () => {
      const other = await conversations.create('claude', [])
      usage = exhausted(clock + HOUR)
      const user = schedules.create({ kind: 'conversation', conversationId: other.id, text: 'nightly' }, null)
      await due()
      const { id } = await limitedChat(clock + HOUR)
      expect(schedules.list().map((each) => each.target.kind)).toEqual(['resume', 'conversation'])

      usage = []
      clock += HOUR + 5_000
      await due()
      expect(continues(id)).toHaveLength(1)
      expect(run(user.id)?.status).toBe('waiting')
    })

    it('waits a while before resuming again when the resume itself ran into the limit', async () => {
      // Items carry the real time, so the reset stays within a few minutes of it.
      const MINUTE = 60_000
      limitTurns(2, null)
      usage = exhausted(clock + MINUTE)
      const conversation = await conversations.create('claude', [])
      await conversations.send(conversation.id, 'go')
      await settle()
      expect(schedules.list()[0]?.notBefore).toBe(clock + MINUTE + 5_000)

      usage = []
      clock += MINUTE + 5_000
      await due()
      expect(continues(conversation.id)).toHaveLength(1)
      const again = schedules.list().find((each) => each.status === 'waiting')
      expect(again?.notBefore).toBe(clock + 15 * 60_000)
      await due()
      expect(continues(conversation.id)).toHaveLength(1)
    })
  })

  describe("a routine's runs", () => {
    const ROUTINE_ID = '00000000-0000-4000-8000-000000000101'
    function daily(patch: Partial<Routine['target']> = {}, enabled = true): Routine {
      return {
        id: ROUTINE_ID, title: '日报', enabled, schedule: { kind: 'daily', time: '09:00' },
        target: { kind: 'new', agent: 'claude', projectPaths: [], text: '写今天的日报', ...patch },
        nextRunAt: null, lastFiredAt: null, unread: 0, lastRun: null, createdAt: 0, updatedAt: 0
      }
    }
    const rows = () => new DatabaseSync(database).prepare('SELECT id, status, conversation_id AS conversationId, routine_id AS routineId, due_at AS dueAt, finished_at AS finishedAt, outcome, seen_at AS seenAt, error FROM scheduled_runs ORDER BY created_at').all()

    it('opens a conversation under its own id, named for the routine, and sends the instruction unattended', async () => {
      routine = daily()
      const made = schedules.insertRoutineRun(routine, clock - 60_000, 'claude')!
      expect(made).toMatchObject({ target: { kind: 'routine', routineId: ROUTINE_ID }, routineId: ROUTINE_ID, dueAt: clock - 60_000, title: '日报', status: 'waiting' })
      await due()
      const conversation = conversations.get(made.id)
      expect(conversation).toMatchObject({ id: made.id, routineId: ROUTINE_ID, titleLocked: true, agent: 'claude' })
      expect(conversation.title.startsWith('日报 · ')).toBe(true)
      expect(userTexts(made.id)).toEqual([`${UNATTENDED_NOTE}\n\n写今天的日报`])
      expect(rows()).toEqual([expect.objectContaining({ id: made.id, status: 'started', conversationId: made.id, finishedAt: null })])
      expect(heard.map((each) => each.status)).toContain('started')
      // The list keeps the run while it is open only; once started it is the routine's history.
      expect(schedules.list()).toEqual([])
    })

    it('makes one run per occurrence, however often the routine comes round to it', () => {
      routine = daily()
      const first = schedules.insertRoutineRun(routine, 1000, 'claude')
      expect(first).not.toBeNull()
      expect(schedules.insertRoutineRun(routine, 1000, 'claude')).toBeNull()
      expect(schedules.recordSkippedRun(routine, 1000, 'previous-running', 'claude')).toBeNull()
      expect(schedules.insertRoutineRun(routine, 2000, 'claude')).not.toBeNull()
      expect(rows()).toHaveLength(2)
    })

    it('keeps the conversation it already made when a start is tried again', async () => {
      routine = daily()
      const made = schedules.insertRoutineRun(routine, clock - 60_000, 'claude')!
      // Core stopped after opening the conversation, before sending: the run was still starting.
      await conversations.create('claude', [], undefined, {}, { id: ROUTINE_ID, title: '日报 · 早' }, made.id)
      new DatabaseSync(database).prepare("UPDATE scheduled_runs SET status = 'starting', conversation_id = ? WHERE id = ?").run(made.id, made.id)
      schedules.stop()
      serve()
      schedules.start()
      expect(rows()[0]).toMatchObject({ status: 'waiting', conversationId: made.id })
      await due()
      expect(rows()[0]).toMatchObject({ status: 'started', conversationId: made.id })
      expect(store.list().map((each) => each.id)).toEqual([made.id])
      expect(userTexts(made.id)).toEqual([`${UNATTENDED_NOTE}\n\n写今天的日报`])
    })

    it('blocks the next occurrence while a run is open or at work, skipped records notwithstanding', async () => {
      routine = daily()
      const made = schedules.insertRoutineRun(routine, 1000, 'claude')!
      expect(schedules.hasBlockingRun(ROUTINE_ID)).toBe(true)
      await due()
      expect(schedules.hasBlockingRun(ROUTINE_ID)).toBe(true)
      schedules.recordSkippedRun(routine, 2000, 'previous-running', 'claude')
      expect(schedules.hasBlockingRun(ROUTINE_ID)).toBe(true)
      expect(schedules.markFinished(made.id, 'awaiting', clock)).toBe(true)
      expect(schedules.hasBlockingRun(ROUTINE_ID)).toBe(false)
      expect(schedules.unfinishedRoutineRuns().map((each) => each.id)).toEqual([made.id])
      expect(schedules.markFinished(made.id, 'completed', clock + 1)).toBe(true)
      expect(schedules.unfinishedRoutineRuns()).toEqual([])
    })

    it('settles an outcome once, reopens a question that was answered, and counts what is unread', async () => {
      routine = daily()
      const made = schedules.insertRoutineRun(routine, 1000, 'claude')!
      await due()
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(0)
      expect(schedules.markFinished(made.id, 'awaiting', clock)).toBe(true)
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(1)
      expect(schedules.markSeen(made.id)).toBe(true)
      expect(schedules.markSeen(made.id)).toBe(false)
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(0)
      // The question answered, the turn ends: that is new to look at.
      expect(schedules.markFinished(made.id, 'completed', clock + 1)).toBe(true)
      expect(rows()[0]).toMatchObject({ outcome: 'completed', seenAt: null })
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(1)
      // A turn replayed from the log changes nothing more.
      expect(schedules.markFinished(made.id, 'failed', clock + 2, 'again')).toBe(false)
      expect(rows()[0]).toMatchObject({ outcome: 'completed', error: null })
      expect(schedules.markAllSeen(ROUTINE_ID)).toBe(true)
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(0)
      expect(schedules.runsFor(ROUTINE_ID, null, 10).map((each) => each.id)).toEqual([made.id])
      expect(schedules.lastRunFor(ROUTINE_ID)?.id).toBe(made.id)
      schedules.clear()
      expect(rows()).toHaveLength(1)
      schedules.deleteRoutineRuns(ROUTINE_ID)
      expect(rows()).toHaveLength(0)
    })

    it('fails a run whose routine is gone or paused, and says which', async () => {
      routine = daily()
      const made = schedules.insertRoutineRun(routine, 1000, 'claude')!
      routine = daily({}, false)
      await due()
      expect(rows()[0]).toMatchObject({ id: made.id, status: 'failed', error: 'routine-paused' })
      expect(schedules.unreadCount(ROUTINE_ID)).toBe(1)
      routine = daily()
      const second = schedules.insertRoutineRun(routine, 2000, 'claude')!
      routine = null
      await due()
      expect(rows()[1]).toMatchObject({ id: second.id, status: 'cancelled', error: 'routine-not-found' })
      const third = schedules.insertRoutineRun(daily(), 3000, 'claude')!
      schedules.cancelRoutineRuns(ROUTINE_ID, 'routine-paused')
      expect(rows()[2]).toMatchObject({ id: third.id, status: 'cancelled', error: 'routine-paused' })
    })

    it("gives an 'auto' routine's run the agent with quota when it starts, and keeps it from then on", async () => {
      routine = daily({ agent: 'auto' })
      // Codex had the quota when the run was made; by the time it starts, Claude does.
      const made = schedules.insertRoutineRun(routine, 1000, 'codex')!
      picked = 'claude'
      await due()
      expect(rows()[0]).toMatchObject({ status: 'started', conversationId: made.id })
      expect(conversations.get(made.id).agent).toBe('claude')
      expect(run(made.id)).toBeUndefined()
      expect(heard.find((each) => each.status === 'started')?.agent).toBe('claude')
    })
  })
})
