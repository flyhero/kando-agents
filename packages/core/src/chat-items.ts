import type { ChatItem } from '@kando/protocol'

// An item as a driver writes it; the book stamps the stage, revision and first-seen time.
export type ChatItemBody = ChatItem extends infer Item
  ? Item extends ChatItem
    ? Omit<Item, 'stageId' | 'revision' | 'at'>
    : never
  : never

export type ChatChanges = { items: ChatItem[]; deltas: Array<{ itemId: string; append: string }> }

// A turn that failed because the account's usage limit was reached, as either agent says so:
// its words, and when the limit lifts if it said.
export type UsageLimitHit = { message: string | null; resetsAt: number | null }

const MAX_TEXT = 20_000

// Keeps a tool's output or input readable in the list without holding a whole log in memory.
export function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字）`
}

// One stage's items in the order they first appeared.
export class ChatItems {
  private readonly items = new Map<string, ChatItem>()
  private readonly order: string[] = []
  private readonly changed = new Set<string>()
  private deltas = new Map<string, string>()
  private notices = 0

  constructor(private readonly stageId: string) {}

  get(id: string): ChatItem | undefined {
    return this.items.get(id)
  }

  put(body: ChatItemBody, at: number): ChatItem {
    const previous = this.items.get(body.id)
    const item: ChatItem = { ...body, stageId: this.stageId, revision: (previous?.revision ?? 0) + 1, at: previous?.at ?? at }
    if (!previous) {
      this.order.push(body.id)
    }
    this.items.set(body.id, item)
    this.changed.add(body.id)
    return item
  }

  // Streamed text: sent on as a delta unless the whole item goes out in the same batch anyway.
  append(id: string, text: string): void {
    const item = this.items.get(id)
    if (!text || !item || (item.kind !== 'assistant' && item.kind !== 'reasoning')) {
      return
    }
    this.items.set(id, { ...item, text: item.text + text })
    this.deltas.set(id, (this.deltas.get(id) ?? '') + text)
  }

  // Calls still running when their turn ends never finish: the turn stopped under them.
  // keepBackground: a turn ending leaves what the agent runs in the background running; only the
  // agent's own exit takes those with it.
  settleTools(status: 'interrupted' | 'failed', at: number, keepBackground = false): void {
    for (const item of this.list()) {
      if (item.kind === 'tool' && item.status === 'running' && !(keepBackground && item.background)) this.put({ ...item, status }, at)
    }
  }

  notice(
    level: 'info' | 'warning' | 'error',
    text: string,
    at: number,
    options: { id?: string; action?: { kind: 'retryCursorTurn'; userItemId: string } | null } = {}
  ): void {
    this.put({ id: options.id ?? `n:${++this.notices}`, kind: 'notice', level, text, ...(options.action !== undefined ? { action: options.action } : {}) }, at)
  }

  // Follows a turn that failed on the account's usage limit: limit:<ref> after turn:<ref>. What is
  // done about it is core's to say; until it does, the limit only waits.
  usageLimit(turnId: string, hit: UsageLimitHit, at: number): void {
    const id = `limit:${turnId.replace(/^turn:/, '')}`
    this.put({ id, kind: 'usageLimit', message: hit.message, resetsAt: hit.resetsAt, autoContinue: false, status: 'waiting', continueAt: null, continuedAt: null, error: null }, at)
  }

  list(): ChatItem[] {
    return this.order.flatMap((id) => {
      const item = this.items.get(id)
      return item ? [item] : []
    })
  }

  // What changed since the last drain. A changed item goes out whole, so its deltas are dropped:
  // the snapshot already holds their text.
  drain(): ChatChanges {
    const items = [...this.changed].flatMap((id) => {
      const item = this.items.get(id)
      return item ? [item] : []
    })
    const deltas = [...this.deltas].flatMap(([itemId, append]) => (this.changed.has(itemId) ? [] : [{ itemId, append }]))
    this.changed.clear()
    this.deltas = new Map()
    return { items, deltas }
  }
}
