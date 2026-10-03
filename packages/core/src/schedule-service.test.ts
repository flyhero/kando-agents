import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Task, type AgentUsage, type ScheduledRun, type ScheduleTaskBlocker, type UnattendedMode } from '@kando/protocol'
import { SCHEDULED_GO_TEXT, UNATTENDED_NOTE } from './agent-prompt'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { ScheduleService } from './schedule-service'
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

  function serve(): void {
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, attachments())
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
      emit: (runs) => { announced = runs }
    }, () => clock)
  }

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
    task = null
    blocker = null
    startFails = null
    starts = []
    serve()
  })

  afterEach(() => {
    schedules.stop()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
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
    schedules.taskChanged({ id: 'task-1', status: 'running' })
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
})
