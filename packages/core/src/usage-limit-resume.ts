import { quotaVerdict, type AgentKind, type AgentUsage, type ChatItem, type LimitRef } from '@kando/protocol'
import type { ConversationService } from './conversation-service'
import { Rejection } from './rejection'
import { GRACE_MS, ScheduleService, type LimitRun } from './schedule-service'

// A limit item older than this when core first sees it was replayed from a log written before
// core knew to act on it: it is shown, not acted on.
const FRESH_MS = 5 * 60_000

type LimitItem = Extract<ChatItem, { kind: 'usageLimit' }>

// Why a resume was cancelled from the card's checkbox: the card then stays, unchecked, for the
// user to check again or retry, where a resume cancelled for other reasons is over.
export const AUTO_CONTINUE_OFF = 'auto-continue-off'

// Turns a usage limit the agent reports into a scheduled resume, and reads the run back onto the
// limit's card: whether core goes on by itself, when, and how it went. The waiting and the
// starting are the ScheduleService's; this only speaks the card's language for them.
export class UsageLimitResumes {
  constructor(
    private readonly schedules: ScheduleService,
    private readonly conversations: Pick<ConversationService, 'get' | 'chatItem'>,
    private readonly usage: { list(): AgentUsage[] },
    // Items with core's plan for them, for the clients watching the conversation.
    private readonly emit: (conversationId: string, items: ChatItem[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  // Limit items as a live stage puts them out. A new one is the conversation's limit now; one a
  // replay brings back is already known, or too old to act on.
  observe(conversationId: string, items: readonly ChatItem[]): void {
    for (const item of items) {
      if (item.kind !== 'usageLimit' || this.now() - item.at >= FRESH_MS || this.schedules.runForLimit(refOf(item))) continue
      const conversation = this.conversation(conversationId)
      if (!conversation) continue
      this.schedules.createResume(conversationId, refOf(item), item.resetsAt ?? this.resetFromUsage(conversation.agent))
    }
  }

  // Limit items with core's plan for them; one core never planned for is shown as settled.
  decorate(items: readonly ChatItem[]): ChatItem[] {
    if (!items.some((item) => item.kind === 'usageLimit')) return [...items]
    return items.map((item) => (item.kind === 'usageLimit' ? withRun(item, this.schedules.runForLimit(refOf(item))) : item))
  }

  // The card's checkbox: on makes a resume where none waits; off cancels the resume, or lets a
  // user's run that took the limit over keep going without it.
  setAutoContinue(conversationId: string, stageId: string, itemId: string, autoContinue: boolean): void {
    const limit = { stageId, itemId }
    const run = this.schedules.runForLimit(limit)
    const open = run !== null && (run.status === 'waiting' || run.status === 'starting')
    if (autoContinue) {
      if (open) return
      if (run?.status === 'started') throw new Rejection('usage-limit-settled', 'this usage limit was already continued')
      const item = this.conversations.chatItem(conversationId, stageId, itemId)
      if (item?.kind !== 'usageLimit') throw new Rejection('usage-limit-not-found', 'no such usage limit in this conversation')
      const conversation = this.conversations.get(conversationId)
      this.schedules.createResume(conversationId, limit, item.resetsAt ?? this.resetFromUsage(conversation.agent))
      return
    }
    if (!run || run.status !== 'waiting') return
    if (run.target.kind === 'resume') this.schedules.cancel(run.id, AUTO_CONTINUE_OFF)
    else this.schedules.unbind(run.id)
  }

  // Goes on now, the way the timer would, but without waiting to see the limit lifted: the user
  // may know better. Resolves once the message is out, or rejects with why it is not.
  async retry(conversationId: string, stageId: string, itemId: string): Promise<void> {
    const run = this.schedules.runForLimit({ stageId, itemId })
    if (!run || run.status === 'starting') throw new Rejection('usage-limit-busy', 'this usage limit is already being retried or settled')
    if (run.status !== 'waiting') throw new Rejection('usage-limit-settled', 'this usage limit is no longer waiting')
    try {
      await this.schedules.runNow(run.id)
    } catch (error) {
      if (error instanceof Rejection && error.reason === 'schedule-busy') throw new Rejection('usage-limit-busy', error.message)
      throw new Rejection('usage-limit-retry-failed', error instanceof Error ? error.message : String(error))
    }
  }

  // When a user action begins, for cancelFor: the limit that action itself runs into comes after.
  mark(): number {
    return this.now()
  }

  // The user went on another way (sent a message, stopped the agent): a resume from before would
  // now continue out of nowhere. A limit their own message hit stays.
  cancelFor(conversationId: string, before: number): void {
    this.schedules.userActed(conversationId, before)
  }

  // The run for a limit changed: its card says so.
  announce(conversationId: string, limit: LimitRef): void {
    const item = this.conversations.chatItem(conversationId, limit.stageId, limit.itemId)
    if (item?.kind === 'usageLimit') this.emit(conversationId, [withRun(item, this.schedules.runForLimit(limit))])
  }

  // When the window holding the agent back lifts, by core's latest reading of its usage.
  private resetFromUsage(agent: AgentKind): number | null {
    const verdict = quotaVerdict(this.usage.list().find((usage) => usage.agent === agent), this.now())
    return verdict.state === 'exhausted' ? (verdict.window?.resetsAt ?? null) : null
  }

  private conversation(id: string) {
    try {
      return this.conversations.get(id)
    } catch {
      return null
    }
  }
}

function refOf(item: LimitItem): LimitRef {
  return { stageId: item.stageId, itemId: item.id }
}

// The card's fields from the run's: waiting with a time while core means to go on; waiting
// unchecked once it gave up, so the user can still retry; continued once it went out.
function withRun(item: LimitItem, run: LimitRun | null): LimitItem {
  if (!run) return { ...item, autoContinue: false, status: 'cancelled', continueAt: null, continuedAt: null, error: null, runId: null }
  const resetsAt = run.resetsAt ?? item.resetsAt
  const base = { ...item, resetsAt, runId: run.id, continuedAt: null, continueAt: null }
  switch (run.status) {
    case 'waiting': {
      const planned = Math.max(run.notBefore ?? 0, run.checkAt ?? 0)
      return { ...base, status: 'waiting', autoContinue: true, error: run.error, continueAt: planned || (resetsAt === null ? null : resetsAt + GRACE_MS) }
    }
    case 'starting':
      return { ...base, status: 'retrying', autoContinue: true, error: run.error }
    case 'started':
      return { ...base, status: 'continued', autoContinue: true, error: null, continuedAt: run.settledAt }
    case 'failed':
      return { ...base, status: 'waiting', autoContinue: false, error: run.error }
    case 'cancelled':
      return run.error === AUTO_CONTINUE_OFF
        ? { ...base, status: 'waiting', autoContinue: false, error: null }
        : { ...base, status: 'cancelled', autoContinue: false, error: null }
  }
}
