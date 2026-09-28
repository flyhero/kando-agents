import type { ChatItem } from '@kando/protocol'

// An item as a driver writes it; the book stamps the stage, revision and first-seen time.
export type ChatItemBody = ChatItem extends infer Item
  ? Item extends ChatItem
    ? Omit<Item, 'stageId' | 'revision' | 'at'>
    : never
  : never

export type ChatChanges = { items: ChatItem[]; deltas: Array<{ itemId: string; append: string }> }

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

  notice(level: 'info' | 'warning' | 'error', text: string, at: number): void {
    this.put({ id: `n:${++this.notices}`, kind: 'notice', level, text }, at)
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
