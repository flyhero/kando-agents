import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { AgentKind, quotaVerdict, USAGE_LIMIT_STATUSES, type AgentUsage, type ChatItem, type Conversation, type Task, type TaskStatus } from '@kando/protocol'
import type { ConversationService } from './conversation-service'
import { Rejection } from './rejection'

// What the agent is told once its limit lifts, as a user would say it: it shows, is searched and
// is handed off like any other message.
export const CONTINUE_TEXT = 'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.'

const TICK_MS = 60_000
// A limit's own clock and the provider's may disagree by a moment.
const GRACE_MS = 5_000
// Nobody could say when the limit lifts: look again after this long.
const UNKNOWN_RESET_MS = 15 * 60_000
// How long to wait after a try that did not go through, by how many have failed so far.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]
// After this many failed tries core stops trying on its own; the card still offers one.
const MAX_ATTEMPTS = 6
// A limit item older than this when core first sees it was replayed from a log written before
// core knew to act on it: it is shown, not acted on.
const FRESH_MS = 5 * 60_000

const Row = z.object({
  id: z.string(),
  conversationId: z.string(),
  stageId: z.string(),
  itemId: z.string(),
  agent: AgentKind,
  resetsAt: z.number().nullable(),
  continueAt: z.number().nullable(),
  autoContinue: z.number().transform((value) => value === 1),
  status: z.enum(USAGE_LIMIT_STATUSES).catch('cancelled'),
  attempts: z.number(),
  error: z.string().nullable(),
  continuedAt: z.number().nullable(),
  createdAt: z.number()
})
type Row = z.infer<typeof Row>
type LimitItem = Extract<ChatItem, { kind: 'usageLimit' }>

const SELECT = `SELECT id, conversation_id AS conversationId, stage_id AS stageId, item_id AS itemId, agent,
  resets_at AS resetsAt, continue_at AS continueAt, auto_continue AS autoContinue, status, attempts, error,
  continued_at AS continuedAt, created_at AS createdAt FROM conversation_usage_limits`

export type UsageLimitDeps = {
  conversations: Pick<ConversationService, 'get' | 'continue' | 'send' | 'sentRef' | 'chatItem'>
  // A task chat goes on through its task, which lays its worktrees out again.
  resumeTask: (taskId: string) => Promise<unknown>
  taskStatus: (taskId: string) => TaskStatus | null
  usage: { list(): AgentUsage[]; refresh(): Promise<AgentUsage[]> }
  // News of a limit item, for the clients watching its conversation.
  emit: (conversationId: string, items: ChatItem[]) => void
}

// Continues a chat whose turn the usage limit stopped, once the limit lifts, with a real message
// from the user's side. The plan lives in the database, so it outlasts the agent being released
// for idleness, the window closing and core restarting; it is checked every minute rather than
// timed, so a computer that slept goes on soon after it wakes.
export class UsageLimitService {
  private readonly db: DatabaseSync
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | null = null

  constructor(
    file: string,
    private readonly deps: UsageLimitDeps,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  start(): void {
    // A try core was making when it stopped: the message went out, or it goes out now.
    for (const row of this.rows('WHERE status = ?', 'retrying')) {
      if (this.wasSent(row)) this.settle(row, { status: 'continued', continued_at: row.continuedAt ?? this.now() })
      else this.settle(row, { status: 'waiting', continue_at: this.now() })
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.db.close()
  }

  // Limit items as a live stage puts them out. A new one is the conversation's limit now; one a
  // replay brings back is already known, or too old to act on.
  observe(conversationId: string, items: readonly ChatItem[]): void {
    for (const item of items) {
      if (item.kind !== 'usageLimit' || this.row(item.stageId, item.id)) continue
      const conversation = this.conversation(conversationId)
      if (!conversation) continue
      const fresh = this.now() - item.at < FRESH_MS
      const resetsAt = item.resetsAt ?? (fresh ? this.resetFromUsage(conversation.agent) : null)
      const at = this.now()
      if (fresh) this.cancelWaiting(conversationId)
      this.db
        .prepare(`INSERT OR IGNORE INTO conversation_usage_limits (id, conversation_id, stage_id, item_id, agent, resets_at, continue_at,
          auto_continue, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), conversationId, item.stageId, item.id, conversation.agent, resetsAt,
          fresh ? continueAt(resetsAt, at) : null, fresh ? 1 : 0, fresh ? 'waiting' : 'cancelled', at, at)
      // The agent's own report from the same output lands just after its items.
      if (fresh && resetsAt === null) void this.deps.usage.refresh().then(() => this.learnReset(item.stageId, item.id), () => {})
    }
  }

  // Limit items with core's plan for them; one core never planned for is shown as settled.
  decorate(items: readonly ChatItem[]): ChatItem[] {
    return items.map((item) => (item.kind === 'usageLimit' ? this.decorated(item) : item))
  }

  setAutoContinue(conversationId: string, stageId: string, itemId: string, autoContinue: boolean): void {
    const row = this.planned(conversationId, stageId, itemId)
    if (row.status !== 'waiting') throw new Rejection('usage-limit-settled', 'this usage limit is no longer waiting')
    this.settle(row, {
      auto_continue: autoContinue ? 1 : 0,
      // Turned back on, perhaps after the limit lifted or tries ran out: from a clean slate.
      ...(autoContinue ? { continue_at: continueAt(row.resetsAt ?? this.resetFromUsage(row.agent), this.now()), attempts: 0 } : {})
    })
  }

  // Goes on now, the way the timer would, but without waiting to see the limit lifted: the user
  // may know better. Resolves once the message is out, or rejects with why it is not.
  async retry(conversationId: string, stageId: string, itemId: string): Promise<void> {
    const row = this.planned(conversationId, stageId, itemId)
    if (!this.claim(row)) throw new Rejection('usage-limit-busy', 'this usage limit is already being retried or settled')
    const failure = await this.attempt(row, true)
    if (failure) throw new Rejection('usage-limit-retry-failed', failure)
  }

  // When a user action begins, for cancelFor: the limit that action itself runs into comes after.
  mark(): number {
    return this.now()
  }

  // The user went on another way (sent a message, stopped the agent): whatever was waiting from
  // before would now continue out of nowhere. A limit their own message hit stays.
  cancelFor(conversationId: string, before: number): void {
    for (const row of this.rows('WHERE conversation_id = ? AND status = ? AND created_at < ?', conversationId, 'waiting', before)) {
      this.settle(row, { status: 'cancelled' })
    }
  }

  // Handing off changes who answers; the old agent's limit is no longer the conversation's.
  conversationChanged(conversation: Conversation): void {
    for (const row of this.rows('WHERE conversation_id = ? AND status = ? AND agent != ?', conversation.id, 'waiting', conversation.agent)) {
      this.settle(row, { status: 'cancelled' })
    }
  }

  // A task chat goes on only while its task is planned or worked on.
  taskChanged(task: Pick<Task, 'status' | 'conversationId'>): void {
    if (task.conversationId && !goesOn(task.status)) this.cancelWaiting(task.conversationId)
  }

  // Tries what is due. One pass at a time: a slow start must not be raced by the next tick.
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async pass(): Promise<void> {
    const now = this.now()
    for (const row of this.rows('WHERE status = ? AND auto_continue = 1 AND continue_at IS NOT NULL AND continue_at <= ?', 'waiting', now)) {
      if (this.claim(row)) await this.attempt(row, false)
    }
  }

  // Returns why the try did not go through, or null once the message is out (or the limit settled).
  private async attempt(row: Row, manual: boolean): Promise<string | null> {
    const conversation = this.conversation(row.conversationId)
    if (!conversation || conversation.agent !== row.agent || (conversation.taskId && !goesOn(this.deps.taskStatus(conversation.taskId)))) {
      this.settle(row, { status: 'cancelled' })
      return null
    }
    if (!manual) {
      // Only a reading taken now tells whether the limit really lifted.
      await this.deps.usage.refresh().catch(() => [])
      const later = this.resetFromUsage(row.agent)
      if (later !== null && later > this.now()) {
        this.settle(row, { status: 'waiting', resets_at: later, continue_at: later + GRACE_MS })
        return null
      }
    }
    const ref = continueRef(row)
    try {
      if (!this.wasSent(row)) {
        if (conversation.taskId) await this.deps.resumeTask(conversation.taskId)
        else await this.deps.conversations.continue(row.conversationId)
        await this.deps.conversations.send(row.conversationId, CONTINUE_TEXT, [], false, false, ref)
      }
      this.settle(row, { status: 'continued', continued_at: this.now(), error: null })
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.conversation(row.conversationId)) {
        this.settle(row, { status: 'cancelled' })
        return message
      }
      const attempts = row.attempts + 1
      this.settle(row, {
        status: 'waiting',
        attempts,
        error: message,
        continue_at: this.now() + (BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? UNKNOWN_RESET_MS),
        ...(attempts >= MAX_ATTEMPTS ? { auto_continue: 0 } : {})
      })
      return message
    }
  }

  private learnReset(stageId: string, itemId: string): void {
    const row = this.row(stageId, itemId)
    if (!row || row.status !== 'waiting' || row.resetsAt !== null) return
    const resetsAt = this.resetFromUsage(row.agent)
    if (resetsAt !== null) this.settle(row, { resets_at: resetsAt, continue_at: continueAt(resetsAt, this.now()) })
  }

  // When the window holding the agent back lifts, by core's latest reading of its usage.
  private resetFromUsage(agent: AgentKind): number | null {
    const verdict = quotaVerdict(this.deps.usage.list().find((usage) => usage.agent === agent), this.now())
    return verdict.state === 'exhausted' ? (verdict.window?.resetsAt ?? null) : null
  }

  private wasSent(row: Row): boolean {
    try {
      return this.deps.conversations.sentRef(row.conversationId, continueRef(row), row.createdAt)
    } catch {
      return false
    }
  }

  // Takes the row for one try; whoever loses the race (two clients, the timer) does nothing.
  private claim(row: Row): boolean {
    const claimed = this.db
      .prepare("UPDATE conversation_usage_limits SET status = 'retrying', updated_at = ? WHERE id = ? AND status = 'waiting'")
      .run(this.now(), row.id).changes === 1
    if (claimed) this.announce({ ...row, status: 'retrying' })
    return claimed
  }

  private cancelWaiting(conversationId: string): void {
    for (const row of this.rows('WHERE conversation_id = ? AND status = ?', conversationId, 'waiting')) {
      this.settle(row, { status: 'cancelled' })
    }
  }

  private settle(row: Row, values: Record<string, SQLInputValue>): void {
    const keys = Object.keys(values)
    this.db
      .prepare(`UPDATE conversation_usage_limits SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => values[key] ?? null), this.now(), row.id)
    const next = this.row(row.stageId, row.itemId)
    if (next) this.announce(next)
  }

  private announce(row: Row): void {
    const item = this.deps.conversations.chatItem(row.conversationId, row.stageId, row.itemId)
    if (item?.kind === 'usageLimit') this.deps.emit(row.conversationId, [withPlan(item, row)])
  }

  private decorated(item: LimitItem): LimitItem {
    const row = this.row(item.stageId, item.id)
    return row ? withPlan(item, row) : { ...item, autoContinue: false, status: 'cancelled', continueAt: null }
  }

  private planned(conversationId: string, stageId: string, itemId: string): Row {
    const row = this.row(stageId, itemId)
    if (!row || row.conversationId !== conversationId) throw new Rejection('usage-limit-not-found', 'no such usage limit in this conversation')
    return row
  }

  private conversation(id: string): Conversation | null {
    try {
      return this.deps.conversations.get(id)
    } catch {
      return null
    }
  }

  private row(stageId: string, itemId: string): Row | null {
    return this.rows('WHERE stage_id = ? AND item_id = ?', stageId, itemId)[0] ?? null
  }

  private rows(where: string, ...values: SQLInputValue[]): Row[] {
    return this.db.prepare(`${SELECT} ${where} ORDER BY created_at, rowid`).all(...values).map((row) => Row.parse(row))
  }
}

function goesOn(status: TaskStatus | null): boolean {
  return status === 'pending' || status === 'running'
}

function continueAt(resetsAt: number | null, now: number): number {
  return resetsAt === null ? now + UNKNOWN_RESET_MS : Math.max(resetsAt + GRACE_MS, now)
}

// The same for every try at one limit, so a message that went out before core stopped is known.
function continueRef(row: Row): string {
  return `usage-limit:${row.id}`
}

function withPlan(item: LimitItem, row: Row): LimitItem {
  return {
    ...item,
    resetsAt: row.resetsAt ?? item.resetsAt,
    autoContinue: row.autoContinue,
    status: row.status,
    continueAt: row.status === 'waiting' && row.autoContinue ? row.continueAt : null,
    continuedAt: row.continuedAt,
    error: row.error
  }
}
