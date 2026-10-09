import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  AGENT_KINDS,
  isValidSchedule,
  latestOccurrenceAtOrBefore,
  nextOccurrence,
  quotaVerdict,
  Routine,
  RoutineSchedule,
  RoutineTarget,
  type AgentKind,
  type AgentUsage,
  type ChatItem,
  type Conversation,
  type QuotaState,
  type RoutineFields,
  type ScheduledRun
} from '@kando/protocol'
import type { ConversationService } from './conversation-service'
import { Rejection } from './rejection'
import type { ScheduleService } from './schedule-service'

// A quota state's place in line for an 'auto' routine: room first, then unknown (signed out, no
// reading yet) ahead of used up.
const QUOTA_RANK: Record<QuotaState, number> = { ok: 0, tight: 1, unknown: 2, exhausted: 3 }

const SELECT = `SELECT id, title, enabled, schedule, target, next_run_at AS nextRunAt, last_fired_at AS lastFiredAt,
  created_at AS createdAt, updated_at AS updatedAt FROM routines`

type Row = Omit<Routine, 'unread' | 'lastRun'>

export type RoutineDeps = {
  schedules: Pick<ScheduleService,
    'insertRoutineRun' | 'recordSkippedRun' | 'hasBlockingRun' | 'unfinishedRoutineRuns' | 'runsFor' | 'lastRunFor' | 'unreadCount'
    | 'markFinished' | 'markSeen' | 'markAllSeen' | 'cancelRoutineRuns' | 'deleteRoutineRuns' | 'runNow' | 'openFor' | 'find'>
  conversations: Pick<ConversationService, 'get' | 'chatPage' | 'clearRoutine'>
  usage: { list(): AgentUsage[] }
  emit: (routines: Routine[]) => void
}

// Rules that start a run on a schedule. Each time one comes due, a run is made for the latest
// occurrence (a computer that slept through several makes up for one) unless a run of it is
// still at work, which is noted instead; the ScheduleService starts the run when quota allows.
// The run's conversation carries the run's id, and its turn, ending, settles the run: by the
// turn item named after the run's message (or the resume that carried it on after a usage
// limit), or by the agent asking something. Where no turn item comes (the agent was lost with
// the daemon, the resume failed), the run is settled from the conversation's log on the next pass.
export class RoutineService {
  private readonly db: DatabaseSync
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(
    file: string,
    private readonly deps: RoutineDeps,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  // What is to come is read off the schedule again: the clocks, or the zone, may have changed
  // since it was written. What is overdue stays so, for the pass to make up for.
  start(): void {
    const now = this.now()
    for (const routine of this.rows('WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at > ?)', now)) {
      const next = nextOccurrence(routine.schedule, now)
      if (next !== routine.nextRunAt) this.write(routine.id, { next_run_at: next })
    }
  }

  stop(): void {
    if (this.pending) clearTimeout(this.pending)
    this.db.close()
  }

  list(): Routine[] {
    return this.rows('ORDER BY created_at').map((row) => this.describe(row))
  }

  get(id: string): Routine | null {
    const row = this.rows('WHERE id = ?', id)[0]
    return row ? this.describe(row) : null
  }

  create(fields: RoutineFields): Routine {
    const { title, schedule, target } = this.check(fields)
    const enabled = fields.enabled ?? true
    const id = randomUUID()
    const at = this.now()
    this.db.prepare(`INSERT INTO routines (id, title, enabled, schedule, target, next_run_at, last_fired_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(id, title, Number(enabled), JSON.stringify(schedule), JSON.stringify(target), enabled ? nextOccurrence(schedule, at) : null, at, at)
    this.announce()
    return this.found(id)
  }

  // A changed schedule starts over from now; pausing drops the runs still waiting.
  update(id: string, patch: Partial<RoutineFields>): Routine {
    const current = this.found(id)
    const { title, schedule, target } = this.check({ title: current.title, schedule: current.schedule, target: current.target, ...patch })
    const enabled = patch.enabled ?? current.enabled
    const values: Record<string, SQLInputValue> = { title, schedule: JSON.stringify(schedule), target: JSON.stringify(target), enabled: Number(enabled) }
    if (patch.schedule !== undefined || patch.enabled !== undefined) values.next_run_at = enabled ? nextOccurrence(schedule, this.now()) : null
    this.write(id, values)
    if (current.enabled && !enabled) this.deps.schedules.cancelRoutineRuns(id, 'routine-paused')
    this.announce()
    return this.found(id)
  }

  // Its runs and their history go with it; the conversations they opened stay, as the user's own.
  delete(id: string): void {
    this.found(id)
    this.deps.schedules.cancelRoutineRuns(id, 'routine-not-found')
    this.deps.schedules.deleteRoutineRuns(id)
    this.deps.conversations.clearRoutine(id)
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id)
    this.announce()
  }

  // Starts a run now, not waiting for the schedule, the quota or the agent's other runs; not
  // while a run of it is still at work.
  async runNow(id: string): Promise<ScheduledRun> {
    const routine = this.found(id)
    if (this.deps.schedules.hasBlockingRun(id)) throw new Rejection('previous-running', 'the last run of this routine has not ended')
    const run = this.deps.schedules.insertRoutineRun(routine, this.now(), this.agentFor(routine))
    if (!run) throw new Rejection('schedule-busy', 'a run for this moment already exists')
    this.write(id, { last_fired_at: this.now() })
    return this.deps.schedules.runNow(run.id)
  }

  runs(id: string, before: number | null, limit: number): ScheduledRun[] {
    this.found(id)
    return this.deps.schedules.runsFor(id, before, limit)
  }

  markSeen(runId: string): void {
    this.deps.schedules.markSeen(runId)
  }

  markAllSeen(id: string): void {
    if (this.deps.schedules.markAllSeen(id)) this.announce()
  }

  // Which agent an 'auto' routine's run spends now: the one with the most room, by its tightest
  // window; one nothing is known of ahead of one used up, which is taken only when both are,
  // the one to reset first.
  pickAgent(routine: Routine): AgentKind {
    if (routine.target.agent !== 'auto') return routine.target.agent
    const now = this.now()
    const ranked = AGENT_KINDS.filter((agent) => agent !== 'cursor').map((agent) => ({ agent, verdict: quotaVerdict(this.deps.usage.list().find((usage) => usage.agent === agent), now) }))
    ranked.sort((a, b) => {
      const byState = QUOTA_RANK[a.verdict.state] - QUOTA_RANK[b.verdict.state]
      if (byState !== 0) return byState
      if (a.verdict.state === 'exhausted') return (a.verdict.window?.resetsAt ?? Infinity) - (b.verdict.window?.resetsAt ?? Infinity)
      return (a.verdict.window?.usedPercent ?? 0) - (b.verdict.window?.usedPercent ?? 0)
    })
    return ranked[0]?.agent ?? 'claude'
  }

  // Called at the start of every scheduler pass: settles what ended without saying so, then
  // makes a run for every routine that has come due.
  async pass(): Promise<void> {
    this.reconcile()
    const now = this.now()
    const due = this.rows('WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at', now)
    for (const routine of due) {
      if (!isValidSchedule(routine.schedule)) {
        this.write(routine.id, { enabled: 0, next_run_at: null })
        continue
      }
      const dueAt = latestOccurrenceAtOrBefore(routine.schedule, now) ?? routine.nextRunAt ?? now
      const described = this.describe(routine)
      const agent = this.agentFor(described)
      if (this.deps.schedules.hasBlockingRun(routine.id)) this.deps.schedules.recordSkippedRun(described, dueAt, 'previous-running', agent)
      else this.deps.schedules.insertRoutineRun(described, dueAt, agent)
      this.write(routine.id, { next_run_at: nextOccurrence(routine.schedule, now), last_fired_at: now })
    }
    if (due.length > 0) this.announce()
  }

  // A turn that ended in a routine's conversation under a scheduled message's name (the run's
  // own, or a resume's) settles the run, unless it ended on the usage limit, which a resume
  // will carry on from.
  observe(conversationId: string, items: readonly ChatItem[]): void {
    const run = this.deps.schedules.find(conversationId)
    if (!run?.routineId) return
    for (const item of items) {
      if (item.kind !== 'turn' || !item.id.startsWith('turn:schedule:')) continue
      const limited = items.some((each) => each.kind === 'usageLimit' && each.id === item.id.replace(/^turn:/, 'limit:'))
      if (limited) continue
      this.deps.schedules.markFinished(run.id, item.state, item.at, item.state === 'completed' ? null : item.error)
    }
  }

  // An agent asking is as far as an unattended run gets: the user should look.
  conversationChanged(conversation: Conversation): void {
    if (conversation.routineId && conversation.chat?.turn === 'awaiting') this.deps.schedules.markFinished(conversation.id, 'awaiting', this.now())
  }

  // A run of a routine changed in the scheduler's hands; the routines are read out again, once,
  // after the scheduler is done.
  runChanged(_run: ScheduledRun): void {
    this.announce()
  }

  // Started runs that have not settled, whose agent is gone with no resume coming: settled from
  // the log where a scheduled turn ended, else as lost.
  private reconcile(): void {
    for (const run of this.deps.schedules.unfinishedRoutineRuns()) {
      const conversation = this.conversation(run.id)
      if (!conversation) {
        this.deps.schedules.markFinished(run.id, 'interrupted', this.now(), 'conversation-not-found')
        continue
      }
      if (conversation.chat) continue
      if (this.deps.schedules.openFor(run.id).some((each) => each.target.kind === 'resume')) continue
      const ended = this.deps.conversations.chatPage(run.id).items.findLast((item) => item.kind === 'turn' && item.id.startsWith('turn:schedule:'))
      if (ended?.kind === 'turn') this.deps.schedules.markFinished(run.id, ended.state, ended.at, ended.state === 'completed' ? null : ended.error)
      else this.deps.schedules.markFinished(run.id, 'interrupted', this.now(), 'agent-lost')
    }
  }

  private agentFor(routine: Routine): AgentKind {
    return routine.target.agent === 'auto' ? this.pickAgent(routine) : routine.target.agent
  }

  private check(fields: RoutineFields): Pick<RoutineFields, 'title' | 'schedule' | 'target'> {
    const title = fields.title.trim()
    if (!title) throw new Rejection('invalid-params', 'a routine needs a title')
    if (!isValidSchedule(fields.schedule)) throw new Rejection('routine-invalid-schedule', 'the schedule names no time')
    const { target } = fields
    if (target.agent === 'cursor') throw new Rejection('cursor-unattended-unsupported', 'Cursor 暂不支持无人值守运行')
    if (!target.text && !target.images?.length) throw new Rejection('routine-no-prompt', 'a routine needs an instruction or images')
    // The agent picked at start chooses its own model.
    const cleaned = target.agent === 'auto' ? { ...target, model: undefined, effort: undefined } : target
    return { title, schedule: fields.schedule, target: cleaned }
  }

  private describe(row: Row): Routine {
    return { ...row, unread: this.deps.schedules.unreadCount(row.id), lastRun: this.deps.schedules.lastRunFor(row.id) }
  }

  private found(id: string): Routine {
    const routine = this.get(id)
    if (!routine) throw new Rejection('routine-not-found', `no routine ${id}`)
    return routine
  }

  private conversation(id: string): Conversation | null {
    try {
      return this.deps.conversations.get(id)
    } catch {
      return null
    }
  }

  private write(id: string, values: Record<string, SQLInputValue>): void {
    const keys = Object.keys(values)
    this.db.prepare(`UPDATE routines SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => values[key] ?? null), this.now(), id)
  }

  // Once per turn of the event loop: a pass touches many runs, the clients hear of it once.
  private announce(): void {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.deps.emit(this.list())
    }, 0)
    this.pending.unref()
  }

  private rows(where: string, ...values: SQLInputValue[]): Row[] {
    return this.db.prepare(`${SELECT} ${where}`).all(...values).flatMap((raw) => {
      const schedule = RoutineSchedule.safeParse(JSON.parse(String(raw.schedule)))
      const target = RoutineTarget.safeParse(JSON.parse(String(raw.target)))
      if (!schedule.success || !target.success) {
        console.error(`[kando-core] routine ${String(raw.id)} cannot be read; skipping it`)
        return []
      }
      return [{
        id: String(raw.id), title: String(raw.title), enabled: Boolean(raw.enabled), schedule: schedule.data, target: target.data,
        nextRunAt: raw.nextRunAt === null ? null : Number(raw.nextRunAt), lastFiredAt: raw.lastFiredAt === null ? null : Number(raw.lastFiredAt),
        createdAt: Number(raw.createdAt), updatedAt: Number(raw.updatedAt)
      }]
    })
  }
}
