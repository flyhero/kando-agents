import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  quotaVerdict,
  ScheduledRun,
  ScheduledTarget,
  type AgentKind,
  type AgentUsage,
  type Conversation,
  type ScheduleTaskBlocker,
  type Task,
  type UnattendedMode
} from '@kando/protocol'
import type { ConversationService } from './conversation-service'
import { Rejection } from './rejection'

const TICK_MS = 60_000
// The quota's clock and the provider's may disagree by a moment.
const GRACE_MS = 5_000
// Nobody could say when the quota resets: look again after this long.
const UNKNOWN_RESET_MS = 15 * 60_000
// How long to wait after a start that did not go through, by how many have failed so far.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]
const MAX_ATTEMPTS = 4
// A run started this long ago no longer holds its agent's turn for the next one.
const HOLD_MS = 24 * 60 * 60_000
// How long settled runs stay in the list, and at most how many.
const KEEP_SETTLED_MS = 7 * 24 * 60 * 60_000
const KEEP_SETTLED = 50
// Refusals that another try would only meet again.
const TRANSIENT = new Set(['chat-busy', 'conversation-running'])

const SELECT = `SELECT id, target, title, agent, not_before AS notBefore, check_at AS checkAt, resets_at AS resetsAt,
  position, status, conversation_id AS conversationId, attempts, error, created_at AS createdAt, settled_at AS settledAt
  FROM scheduled_runs`

type Row = ScheduledRun & { checkAt: number | null; position: number }

function row(raw: Record<string, unknown>): Row {
  const target = ScheduledTarget.safeParse(JSON.parse(String(raw.target)))
  const run = ScheduledRun.parse({
    ...raw,
    target: target.success ? target.data : { kind: 'task', taskId: '' },
    status: target.success ? raw.status : 'cancelled'
  })
  return { ...run, checkAt: raw.checkAt === null ? null : Number(raw.checkAt), position: Number(raw.position) }
}

function publicRun({ checkAt: _checkAt, position: _position, ...run }: Row): ScheduledRun {
  return run
}

export type ScheduleDeps = {
  tasks: {
    get(id: string): Task | null
    scheduleBlocker(id: string): ScheduleTaskBlocker | null
    start(id: string, allowBypass: boolean | undefined, unattended: UnattendedMode): Promise<Task>
    resumeChat(id: string, allowBypass?: boolean): Promise<Task>
  }
  conversations: Pick<ConversationService, 'get' | 'continue' | 'runScheduled' | 'sentRef'>
  usage: { list(): AgentUsage[]; refresh(): Promise<AgentUsage[]> }
  // The mode runs start in, as the user last set it.
  mode: () => UnattendedMode
  emit: (runs: ScheduledRun[]) => void
}

// Starts what the user scheduled once its time has come and its agent has quota again: a task,
// carried out unattended, or a conversation, going on with its plan or a message. Runs of one
// agent go one at a time in list order, so a quota that has just reset is not spent all at once.
// The plan lives in the database and is checked every minute, as UsageLimitService does: it
// outlasts the window closing and core restarting, and a computer that slept goes on once it wakes.
export class ScheduleService {
  private readonly db: DatabaseSync
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | null = null
  private queued: Promise<void> | null = null

  constructor(
    file: string,
    private readonly deps: ScheduleDeps,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  start(): void {
    // A start core was making when it stopped: it went through, or it is tried again.
    for (const run of this.rows("WHERE status = 'starting'")) {
      const conversationId = this.startedIn(run)
      if (conversationId !== undefined) this.settle(run, { status: 'started', conversation_id: conversationId, settled_at: this.now() })
      else this.settle(run, { status: 'waiting', check_at: null })
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.db.close()
  }

  // The open runs in the order they go, then the latest settled.
  list(): ScheduledRun[] {
    const open = this.rows("WHERE status IN ('waiting', 'starting') ORDER BY position")
    const settled = this.rows("WHERE status NOT IN ('waiting', 'starting') AND settled_at > ? ORDER BY settled_at DESC LIMIT ?",
      this.now() - KEEP_SETTLED_MS, KEEP_SETTLED)
    return [...open, ...settled].map(publicRun)
  }

  // Runs still to start, which keep the computer awake.
  openCount(): number {
    const found = this.db.prepare("SELECT COUNT(*) AS count FROM scheduled_runs WHERE status IN ('waiting', 'starting')").get()
    return Number(found?.count ?? 0)
  }

  create(target: ScheduledTarget, notBefore: number | null): ScheduledRun {
    const { title, agent } = this.describe(target)
    if (target.kind === 'task') {
      const blocker = this.deps.tasks.scheduleBlocker(target.taskId)
      if (blocker) throw new Rejection(blocker)
      if (this.rows("WHERE status IN ('waiting', 'starting')").some((run) => run.target.kind === 'task' && run.target.taskId === target.taskId)) {
        throw new Rejection('already-scheduled', 'this task is already scheduled')
      }
    }
    const id = randomUUID()
    const last = this.db.prepare('SELECT MAX(position) AS position FROM scheduled_runs').get()
    const at = this.now()
    this.db.prepare(`INSERT INTO scheduled_runs (id, target, title, agent, not_before, position, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`)
      .run(id, JSON.stringify(target), title, agent, notBefore, Number(last?.position ?? 0) + 1, at, at)
    this.announce()
    // One due already goes at once, rather than up to a minute later.
    void this.tick()
    return publicRun(this.found(id))
  }

  update(id: string, patch: { notBefore?: number | null; text?: string }): ScheduledRun {
    const run = this.waiting(id)
    const values: Record<string, SQLInputValue> = { check_at: null }
    if (patch.notBefore !== undefined) values.not_before = patch.notBefore
    if (patch.text !== undefined) {
      if (run.target.kind !== 'conversation') throw new Rejection('schedule-no-text', 'only a conversation run sends a message')
      values.target = JSON.stringify({ ...run.target, text: patch.text })
    }
    this.settle(run, values)
    void this.tick()
    return publicRun(this.found(id))
  }

  // The open runs named go in this order, ahead of any not named.
  reorder(ids: readonly string[]): void {
    const open = this.rows("WHERE status IN ('waiting', 'starting') ORDER BY position")
    const named = ids.flatMap((id) => open.filter((run) => run.id === id))
    const ordered = [...named, ...open.filter((run) => !ids.includes(run.id))]
    const move = this.db.prepare('UPDATE scheduled_runs SET position = ?, updated_at = ? WHERE id = ?')
    ordered.forEach((run, index) => move.run(index + 1, this.now(), run.id))
    this.announce()
  }

  cancel(id: string): ScheduledRun {
    const run = this.waiting(id)
    this.settle(run, { status: 'cancelled', settled_at: this.now() })
    return publicRun(this.found(id))
  }

  // Starts it now, not waiting for its time, its agent's quota or the agent's other runs: the user
  // may know better. Rejects with why it did not start.
  async runNow(id: string): Promise<ScheduledRun> {
    const run = this.waiting(id)
    if (!this.claim(run)) throw new Rejection('schedule-busy', 'this run is already starting')
    const failure = await this.attempt(run)
    if (failure) throw failure
    return publicRun(this.found(id))
  }

  clear(): void {
    this.db.prepare("DELETE FROM scheduled_runs WHERE status NOT IN ('waiting', 'starting')").run()
    this.announce()
  }

  // A task started by hand, or deleted, has nothing left for its run to start.
  taskChanged(task: Pick<Task, 'id' | 'status'>): void {
    if (task.status !== 'pending') this.cancelFor((target) => target.kind === 'task' && target.taskId === task.id, 'task-started')
  }

  taskDeleted(id: string): void {
    this.cancelFor((target) => target.kind === 'task' && target.taskId === id, 'task-not-found')
  }

  conversationDeleted(id: string): void {
    this.cancelFor((target) => target.kind === 'conversation' && target.conversationId === id, 'conversation-not-found')
  }

  // Tries what is due. One pass at a time: a slow start must not be raced by the next tick. One
  // asked for meanwhile runs once that pass is over, so a run just made or changed is not missed.
  tick(): Promise<void> {
    if (this.ticking) {
      this.queued ??= this.ticking.then(() => {
        this.queued = null
        return this.tick()
      })
      return this.queued
    }
    this.ticking = this.pass().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async pass(): Promise<void> {
    const now = this.now()
    const due = this.rows("WHERE status = 'waiting' AND (not_before IS NULL OR not_before <= ?) AND (check_at IS NULL OR check_at <= ?) ORDER BY position", now, now)
    if (due.length === 0) return
    // Only a reading taken now tells whether a quota has really reset.
    await this.deps.usage.refresh().catch(() => [])
    // An agent goes on with one run at a time.
    const held = new Set<AgentKind>()
    for (const run of due) {
      const agent = this.agentOf(run)
      if (agent === null) {
        this.settle(run, { status: 'cancelled', error: run.target.kind === 'task' ? 'task-not-found' : 'conversation-not-found', settled_at: this.now() })
        continue
      }
      // Every run of an agent whose quota is used up waits for the reset, and says when it is.
      const exhausted = this.exhausted(agent)
      if (exhausted) {
        const resetsAt = exhausted.resetsAt
        this.settle(run, { agent, resets_at: resetsAt, check_at: resetsAt !== null && resetsAt > this.now() ? resetsAt + GRACE_MS : this.now() + UNKNOWN_RESET_MS })
        continue
      }
      if (held.has(agent) || this.working(agent)) {
        held.add(agent)
        continue
      }
      held.add(agent)
      if (agent !== run.agent || run.resetsAt !== null) this.settle(run, { agent, resets_at: null })
      if (this.claim(run)) await this.attempt(run)
    }
  }

  // Returns why the start did not go through, or null once it did.
  private async attempt(run: Row): Promise<Rejection | Error | null> {
    try {
      const conversationId = await this.fire(run)
      this.settle(run, { status: 'started', conversation_id: conversationId, settled_at: this.now(), error: null, resets_at: null })
      return null
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown))
      const reason = error instanceof Rejection ? error.reason : error.message
      const attempts = run.attempts + 1
      if ((error instanceof Rejection && !TRANSIENT.has(error.reason)) || attempts >= MAX_ATTEMPTS) {
        this.settle(run, { status: 'failed', attempts, error: reason, settled_at: this.now() })
      } else {
        this.settle(run, { status: 'waiting', attempts, error: reason, check_at: this.now() + (BACKOFF_MS[attempts - 1] ?? UNKNOWN_RESET_MS) })
      }
      return error
    }
  }

  // Starts the run; resolves to the conversation it went on in.
  private async fire(run: Row): Promise<string | null> {
    const mode = this.deps.mode()
    const bypass = mode === 'bypass' ? true : undefined
    const { target } = run
    if (target.kind === 'task') {
      const task = await this.deps.tasks.start(target.taskId, bypass, mode)
      return task.conversationId
    }
    const conversation = this.deps.conversations.get(target.conversationId)
    const { taskId } = conversation
    const ready = taskId
      ? () => this.deps.tasks.resumeChat(taskId, bypass)
      : () => this.deps.conversations.continue(conversation.id, bypass)
    await this.deps.conversations.runScheduled(conversation.id, target.text, mode, ready, scheduleRef(run))
    return conversation.id
  }

  // Where a run core was starting when it stopped went on, or undefined when it did not.
  private startedIn(run: Row): string | null | undefined {
    const { target } = run
    if (target.kind === 'task') {
      const task = this.deps.tasks.get(target.taskId)
      return task && task.status !== 'pending' ? task.conversationId : undefined
    }
    try {
      return this.deps.conversations.sentRef(target.conversationId, scheduleRef(run), run.createdAt) ? target.conversationId : undefined
    } catch {
      return undefined
    }
  }

  private describe(target: ScheduledTarget): { title: string; agent: AgentKind } {
    if (target.kind === 'task') {
      const task = this.deps.tasks.get(target.taskId)
      if (!task) throw new Rejection('task-not-found')
      if (!task.agent) throw new Rejection('missing-agent')
      return { title: task.title, agent: task.agent }
    }
    const conversation = this.deps.conversations.get(target.conversationId)
    return { title: conversation.title, agent: conversation.agent }
  }

  // Whose quota the run spends now: a conversation may have been handed to the other agent.
  private agentOf(run: Row): AgentKind | null {
    const { target } = run
    if (target.kind === 'task') return this.deps.tasks.get(target.taskId)?.agent ?? null
    return this.conversation(target.conversationId)?.agent ?? null
  }

  // Whether a run of this agent is still at work: the next waits for its turn to end.
  private working(agent: AgentKind): boolean {
    return this.rows("WHERE status = 'started' AND agent = ? AND settled_at > ?", agent, this.now() - HOLD_MS)
      .some((run) => run.conversationId !== null && this.conversation(run.conversationId)?.chat?.turn === 'running')
  }

  private exhausted(agent: AgentKind): { resetsAt: number | null } | null {
    const verdict = quotaVerdict(this.deps.usage.list().find((usage) => usage.agent === agent), this.now())
    return verdict.state === 'exhausted' ? { resetsAt: verdict.window?.resetsAt ?? null } : null
  }

  private cancelFor(matches: (target: ScheduledRun['target']) => boolean, reason: string): void {
    const runs = this.rows("WHERE status = 'waiting'").filter((run) => matches(run.target))
    for (const run of runs) this.settle(run, { status: 'cancelled', error: reason, settled_at: this.now() }, false)
    if (runs.length > 0) this.announce()
  }

  // Takes the run for one start; whoever loses the race (two clients, the timer) does nothing.
  private claim(run: Row): boolean {
    const claimed = this.db
      .prepare("UPDATE scheduled_runs SET status = 'starting', updated_at = ? WHERE id = ? AND status = 'waiting'")
      .run(this.now(), run.id).changes === 1
    if (claimed) this.announce()
    return claimed
  }

  private waiting(id: string): Row {
    const run = this.found(id)
    if (run.status !== 'waiting') throw new Rejection('schedule-settled', 'this run is no longer waiting')
    return run
  }

  private found(id: string): Row {
    const run = this.rows('WHERE id = ?', id)[0]
    if (!run) throw new Rejection('schedule-not-found', `no scheduled run ${id}`)
    return run
  }

  private conversation(id: string): Conversation | null {
    try {
      return this.deps.conversations.get(id)
    } catch {
      return null
    }
  }

  private settle(run: Row, values: Record<string, SQLInputValue>, announce = true): void {
    const keys = Object.keys(values)
    this.db
      .prepare(`UPDATE scheduled_runs SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => values[key] ?? null), this.now(), run.id)
    if (announce) this.announce()
  }

  private announce(): void {
    this.deps.emit(this.list())
  }

  private rows(where: string, ...values: SQLInputValue[]): Row[] {
    return this.db.prepare(`${SELECT} ${where}`).all(...values).map(row)
  }
}

// Names the message a conversation run sends, so a start retried after a restart is not sent twice.
function scheduleRef(run: Pick<ScheduledRun, 'id'>): string {
  return `schedule:${run.id}`
}
