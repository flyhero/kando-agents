import { BROWSER_HOST_TOOL } from '@kando/protocol'
import type { ChatRecord } from './chat-driver'
import type { ChatItems } from './chat-items'

export type KandoAsk = Extract<ChatRecord, { dir: 'ask' }>['ask']
export type KandoResolution = Extract<ChatRecord, { dir: 'answer' }>['resolution']

// Questions Kando itself puts to the user mid-chat (the site its browser may open), shown as
// approvals beside the agent's own. Both drivers hold one, fed from the stage's records, so a
// replayed stage shows them answered as they were.
export class KandoRequests {
  private readonly open = new Set<string>()

  constructor(private readonly items: ChatItems) {}

  get pending(): number {
    return this.open.size
  }

  apply(record: Extract<ChatRecord, { dir: 'ask' | 'answer' }>): void {
    const id = `a:${record.requestId}`
    if (record.dir === 'ask') {
      this.open.add(record.requestId)
      this.items.put({
        id,
        kind: 'approval',
        requestId: record.requestId,
        tool: BROWSER_HOST_TOOL,
        title: record.ask.host,
        detail: record.ask.url,
        toolItemId: null,
        decisions: ['allow', 'allowForSession', 'deny'],
        resolution: null
      }, record.at)
      return
    }
    const item = this.items.get(id)
    if (item?.kind !== 'approval') return
    this.open.delete(record.requestId)
    this.items.put({ ...item, resolution: record.resolution }, record.at)
  }

  // The agent is gone: nothing is left for an answer to reach.
  cancelAll(at: number): void {
    for (const requestId of [...this.open]) this.apply({ dir: 'answer', at, requestId, resolution: 'cancelled' })
  }
}
