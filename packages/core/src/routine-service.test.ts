import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextOccurrence, type AgentUsage, type Routine, type RoutineFields, type UnattendedMode } from '@kando/protocol'
import { UNATTENDED_NOTE } from './agent-prompt'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { RoutineService } from './routine-service'
import { ScheduleService } from './schedule-service'
import { UsageLimitResumes } from './usage-limit-resume'
import { TaskStore } from './task-store'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const pad = (value: number) => String(value).padStart(2, '0')
// The local clock time of a moment, as a schedule names it.
const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

describe('RoutineService', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let schedules: ScheduleService
  let routines: RoutineService
  let limits: UsageLimitResumes
  let clock: number
  let usage: AgentUsage[]
  let mode: UnattendedMode
  let emitted: Routine[][]
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  function serve(): void {
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (event) => {
        if (event.type === 'chatItems') {
          limits.observe(event.conversationId, event.items)
          routines.observe(event.conversationId, event.items)
        } else if (event.type === 'changed') {
          routines.conversationChanged(event.conversation)
        }
      },
      projects, attachments())
    const target = conversations
    daemon.deliver = (event) => {
      if (event.event === 'data') target.handleData(event)
      else if (event.event === 'exit') target.handleExit(event.sessionId, event.exitCode)
      else target.handleStderr(event.sessionId, event.data)
    }
    schedules = new ScheduleService(database, {
      tasks: { get: () => null, scheduleBlocker: () => null, start: async () => { throw new Error('no tasks here') }, resumeChat: async () => { throw new Error('no tasks here') } },
      conversations,
      usage: { list: () => usage, refresh: async () => usage },
      mode: () => mode,
      emit: () => {},
      limitChanged: (conversationId, limit) => limits.announce(conversationId, limit),
      routines: {
        pass: () => routines.pass(),
        get: (id) => routines.get(id),
        pickAgent: (routine) => routines.pickAgent(routine),
        runChanged: (run) => routines.runChanged(run)
      }
    }, () => clock)
    limits = new UsageLimitResumes(schedules, conversations, { list: () => usage }, () => {}, () => clock)
    routines = new RoutineService(database, { schedules, conversations, usage: { list: () => usage }, emit: (list) => { emitted.push(list) } }, () => clock)
  }

  function attachments(): AttachmentStore {
    const dir = path.join(root, 'attachments')
    mkdirSync(dir, { recursive: true })
    return new AttachmentStore(dir)
  }

  function exhausted(agent: 'claude' | 'codex', resetsAt: number | null): AgentUsage {
    return { agent, status: 'ok', plan: null, error: null, updatedAt: clock, resetCredits: null,
      windows: [{ kind: 'session', model: null, usedPercent: 100, windowMinutes: 300, resetsAt }] }
  }

  function roomy(agent: 'claude' | 'codex', usedPercent: number): AgentUsage {
    return { agent, status: 'ok', plan: null, error: null, updatedAt: clock, resetCredits: null,
      windows: [{ kind: 'session', model: null, usedPercent, windowMinutes: 300, resetsAt: clock + HOUR }] }
  }

  // The first `turns` messages Claude Code gets run into the five-hour limit; later ones go through.
  function limitTurns(turns: number, resetsAt: number): void {
    const answer = daemon.reply
    let left = turns
    daemon.reply = (sessionId, text) => {
      if (left <= 0) return answer(sessionId, text)
      left -= 1
      daemon.emit(sessionId, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAt / 1000 } })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", duration_ms: 20 })
    }
  }

  // A routine due one minute from now, daily.
  function dailySoon(patch: Partial<RoutineFields['target']> = {}): { routine: Routine; dueAt: number } {
    const dueAt = nextOccurrence({ kind: 'daily', time: hhmm(clock + 60_000) }, clock)!
    const routine = routines.create({ title: '日报', schedule: { kind: 'daily', time: hhmm(dueAt) }, target: { kind: 'new', agent: 'claude', projectPaths: [], text: '写今天的日报', ...patch } })
    return { routine, dueAt }
  }

  async function tick(): Promise<void> {
    await schedules.tick()
    await settle()
  }

  const runs = (id: string) => schedules.runsFor(id, null, 50)
  const rawRuns = () => new DatabaseSync(database).prepare('SELECT id, status, due_at AS dueAt, finished_at AS finishedAt, outcome, seen_at AS seenAt, error FROM scheduled_runs ORDER BY created_at, rowid').all()
  const userTexts = (id: string) => conversations.chatPage(id).items.flatMap((item) => (item.kind === 'user' ? [item.text] : []))

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-routine-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    // Chat items carry the real time, which the usage-limit resume compares the clock with.
    clock = Date.now()
    usage = []
    mode = 'acceptEdits'
    emitted = []
    serve()
  })

  afterEach(() => {
    routines.stop()
    schedules.stop()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('opens a conversation when the routine comes due, named for it, and settles the run when the turn ends', async () => {
    const { routine, dueAt } = dailySoon()
    expect(routine).toMatchObject({ enabled: true, nextRunAt: dueAt, unread: 0, lastRun: null })
    await tick()
    expect(runs(routine.id)).toEqual([])

    clock = dueAt
    await tick()
    const [run] = runs(routine.id)
    expect(run).toMatchObject({ status: 'started', dueAt, conversationId: run!.id, routineId: routine.id, outcome: 'completed', seenAt: null })
    expect(run!.finishedAt).not.toBeNull()
    const conversation = conversations.get(run!.id)
    expect(conversation).toMatchObject({ routineId: routine.id, titleLocked: true, agent: 'claude' })
    expect(conversation.title.startsWith('日报 · ')).toBe(true)
    expect(userTexts(run!.id)).toEqual([`${UNATTENDED_NOTE}\n\n写今天的日报`])
    expect(routines.get(routine.id)).toMatchObject({ nextRunAt: dueAt + DAY, lastFiredAt: dueAt, unread: 1, lastRun: expect.objectContaining({ id: run!.id }) })
    expect(emitted.at(-1)?.[0]?.unread).toBe(1)

    routines.markSeen(run!.id)
    expect(routines.get(routine.id)?.unread).toBe(0)
  })

  it('makes up for one occurrence, the latest, after the computer slept through several', async () => {
    const { routine, dueAt } = dailySoon()
    clock = dueAt + 3 * DAY + HOUR
    await tick()
    expect(runs(routine.id).map((run) => run.dueAt)).toEqual([dueAt + 3 * DAY])
    expect(routines.get(routine.id)?.nextRunAt).toBe(dueAt + 4 * DAY)
    await tick()
    expect(runs(routine.id)).toHaveLength(1)
  })

  it('does not run an occurrence twice when the routine was not moved on after its run was made', async () => {
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    // Core stopped between inserting the run and moving the routine on.
    new DatabaseSync(database).prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(dueAt, routine.id)
    await tick()
    expect(runs(routine.id)).toHaveLength(1)
    expect(routines.get(routine.id)?.nextRunAt).toBe(dueAt + DAY)
  })

  it('notes an occurrence it lets pass while the last run is still at work, and runs again once that ends', async () => {
    daemon.reply = () => {}
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    const [first] = runs(routine.id)
    expect(first).toMatchObject({ status: 'started', finishedAt: null })

    clock = dueAt + DAY
    await tick()
    clock = dueAt + 2 * DAY
    await tick()
    expect(rawRuns().map((row) => [row.status, row.error])).toEqual([['started', null], ['cancelled', 'previous-running'], ['cancelled', 'previous-running']])
    expect(routines.get(routine.id)?.unread).toBe(0)

    const sessionId = conversations.get(first!.id).sessionId ?? ''
    daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: false, result: 'done', terminal_reason: 'completed', duration_ms: 5 })
    await settle()
    expect(runs(routine.id).find((run) => run.id === first!.id)).toMatchObject({ outcome: 'completed' })
    clock = dueAt + 3 * DAY
    await tick()
    expect(runs(routine.id).filter((run) => run.status === 'started')).toHaveLength(2)
  })

  it('does not settle a run whose turn hit the usage limit; the resume that carries it on does', async () => {
    const resetsAt = clock + HOUR
    limitTurns(1, resetsAt)
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    const [run] = runs(routine.id)
    expect(run).toMatchObject({ status: 'started', finishedAt: null })
    expect(schedules.openFor(run!.id).map((each) => each.target.kind)).toEqual(['resume'])
    // The agent is idle, but a resume is coming: not lost.
    await tick()
    expect(runs(routine.id)[0]?.finishedAt).toBeNull()

    clock = resetsAt + 5_000
    await tick()
    expect(runs(routine.id)[0]).toMatchObject({ outcome: 'completed', seenAt: null })
    expect(routines.get(routine.id)?.unread).toBe(1)
  })

  it('settles a run as awaiting when the agent asks, and lets the next occurrence go ahead', async () => {
    daemon.reply = (id) => daemon.emit(id, {
      type: 'control_request', request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_ask-1' }
    })
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    const [run] = runs(routine.id)
    expect(run).toMatchObject({ outcome: 'awaiting', seenAt: null })
    expect(run!.finishedAt).not.toBeNull()
    expect(routines.get(routine.id)?.unread).toBe(1)
    expect(schedules.hasBlockingRun(routine.id)).toBe(false)

    clock = dueAt + DAY
    await tick()
    expect(runs(routine.id).filter((each) => each.status === 'started')).toHaveLength(2)
  })

  it('settles a run whose agent was lost with the daemon as interrupted, from the next pass', async () => {
    daemon.reply = () => {}
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    const [run] = runs(routine.id)
    expect(run?.finishedAt).toBeNull()
    // The daemon came back knowing no sessions: the agent is gone, and said nothing on its way.
    await conversations.reconcile([])
    expect(conversations.get(run!.id).chat).toBeNull()
    await tick()
    expect(runs(routine.id)[0]).toMatchObject({ outcome: 'interrupted', error: 'agent-lost' })
    expect(routines.get(routine.id)?.unread).toBe(1)
  })

  it('counts a run that could not start as something to look at, until all are marked seen', async () => {
    const { routine, dueAt } = dailySoon({ model: 'no-such-model' })
    clock = dueAt
    await tick()
    expect(runs(routine.id)[0]).toMatchObject({ status: 'failed', error: 'chat-option-invalid' })
    expect(routines.get(routine.id)?.unread).toBe(1)
    routines.markAllSeen(routine.id)
    expect(routines.get(routine.id)?.unread).toBe(0)
  })

  it("picks the agent with room for an 'auto' routine, the one to reset first when both are used up", () => {
    const auto: Routine = { ...dailySoon().routine, target: { kind: 'new', agent: 'auto', projectPaths: [], text: 'x' } }
    expect(routines.pickAgent(auto)).toBe('claude')
    usage = [exhausted('claude', clock + HOUR), roomy('codex', 50)]
    expect(routines.pickAgent(auto)).toBe('codex')
    usage = [roomy('claude', 20), roomy('codex', 50)]
    expect(routines.pickAgent(auto)).toBe('claude')
    usage = [roomy('claude', 90), roomy('codex', 50)]
    expect(routines.pickAgent(auto)).toBe('codex')
    usage = [exhausted('claude', clock + 2 * HOUR), exhausted('codex', clock + HOUR)]
    expect(routines.pickAgent(auto)).toBe('codex')
    usage = [exhausted('claude', clock + HOUR)]
    expect(routines.pickAgent(auto)).toBe('codex')
  })

  it('pauses, which drops the run still waiting, and deletes, which hands its conversations back', async () => {
    const { routine, dueAt } = dailySoon()
    clock = dueAt
    await tick()
    const [done] = runs(routine.id)
    usage = [exhausted('claude', clock + 2 * DAY)]
    clock = dueAt + DAY
    await tick()
    expect(runs(routine.id).map((run) => run.status)).toEqual(['waiting', 'started'])
    await expect(routines.runNow(routine.id)).rejects.toMatchObject({ reason: 'previous-running' })

    const paused = routines.update(routine.id, { enabled: false })
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
    expect(runs(routine.id).map((run) => [run.status, run.error])).toEqual([['cancelled', 'routine-paused'], ['started', null]])
    clock = dueAt + 2 * DAY
    await tick()
    expect(runs(routine.id)).toHaveLength(2)

    const resumed = routines.update(routine.id, { enabled: true, schedule: { kind: 'hourly', every: 1 } })
    expect(resumed.nextRunAt).toBe(nextOccurrence({ kind: 'hourly', every: 1 }, clock))

    routines.delete(routine.id)
    expect(routines.list()).toEqual([])
    expect(rawRuns()).toEqual([])
    expect(conversations.get(done!.id).routineId).toBeNull()
    expect(() => routines.update(routine.id, { title: 'x' })).toThrow(Rejection)
  })

  it('starts a run by hand at once, and refuses a routine with nothing to say or no time', async () => {
    const { routine } = dailySoon()
    const run = await routines.runNow(routine.id)
    await settle()
    expect(run.status).toBe('started')
    expect(runs(routine.id)[0]).toMatchObject({ id: run.id, outcome: 'completed' })
    expect(() => routines.create({ title: 'x', schedule: { kind: 'manual' }, target: { kind: 'new', agent: 'claude', projectPaths: [], text: '' } })).toThrow(expect.objectContaining({ reason: 'routine-no-prompt' }))
    expect(() => routines.create({ title: 'x', schedule: { kind: 'weekly', days: [], time: '09:00' }, target: { kind: 'new', agent: 'claude', projectPaths: [], text: 'go' } })).toThrow(expect.objectContaining({ reason: 'routine-invalid-schedule' }))
    const manual = routines.create({ title: 'by hand', schedule: { kind: 'manual' }, target: { kind: 'new', agent: 'auto', projectPaths: [], text: 'go', model: 'ignored' } })
    expect(manual).toMatchObject({ nextRunAt: null, target: expect.not.objectContaining({ model: 'ignored' }) })
  })

  it('reads what is to come off the schedule again when it starts, leaving what is overdue to make up for', async () => {
    const { routine, dueAt } = dailySoon()
    new DatabaseSync(database).prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(dueAt + 12 * HOUR, routine.id)
    routines.start()
    expect(routines.get(routine.id)?.nextRunAt).toBe(dueAt)
    new DatabaseSync(database).prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(dueAt - 2 * DAY, routine.id)
    routines.start()
    expect(routines.get(routine.id)?.nextRunAt).toBe(dueAt - 2 * DAY)
  })
})
