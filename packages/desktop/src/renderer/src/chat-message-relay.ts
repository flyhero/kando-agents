import type { ChatItem } from '@kando/protocol'
import { itemKey } from './chat-state'

export type RelayMessage = {
  text: string
  images: readonly string[]
  known: ReadonlySet<string>
}

// The send reply and the chat notification can arrive in either order.
export function relayMessage(items: readonly ChatItem[], sent: RelayMessage): Extract<ChatItem, { kind: 'user' }> | null {
  return items.findLast((item): item is Extract<ChatItem, { kind: 'user' }> =>
    item.kind === 'user' && !sent.known.has(itemKey(item)) && item.text === sent.text &&
    item.images.length === sent.images.length && item.images.every((image, index) => image.id === sent.images[index])
  ) ?? null
}
