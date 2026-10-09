import type { ChatImage, ChatQueued, ChatTurnState } from '@kando/protocol'
import type { ChatRecord } from './chat-driver'

type Entry = { text: string; images: ChatImage[]; ref: string; held: boolean }

// The messages the user wrote while the agent worked, sent one at a time as each turn completes:
// the next waits for the turn the one before it started. A turn that was interrupted or failed
// holds them all; the user releases them one by one, or drops them.
export class ChatQueue {
  private entries: Entry[] = []

  // A queue record from the log: a message to wait, one released from being held, one dropped,
  // or, with no ref, every one dropped.
  apply(record: Extract<ChatRecord, { dir: 'queue' }>): void {
    if (record.text !== null && record.ref) this.add(record.text, record.ref, record.images, record.held)
    else if (record.release && record.ref) this.release(record.ref)
    else this.drop(record.ref)
  }

  add(text: string, ref: string, images: readonly ChatImage[] = [], held = false): void {
    this.entries = [...this.entries.filter((entry) => entry.ref !== ref), { text, images: [...images], ref, held }]
  }

  drop(ref: string | undefined): void {
    this.entries = ref === undefined ? [] : this.entries.filter((entry) => entry.ref !== ref)
  }

  release(ref: string): void {
    this.entries = this.entries.map((entry) => (entry.ref === ref ? { ...entry, held: false } : entry))
  }

  // The message went out as the user message with this ref.
  sent(ref: string | undefined): void {
    if (ref) this.drop(ref)
  }

  turnEnded(state: ChatTurnState): void {
    if (state !== 'completed') this.entries = this.entries.map((entry) => ({ ...entry, held: true }))
  }

  // The next to go: the first not held.
  next(): { text: string; images: ChatImage[]; ref: string } | null {
    const entry = this.entries.find((each) => !each.held)
    return entry ? { text: entry.text, images: entry.images, ref: entry.ref } : null
  }

  get(ref: string | undefined): ChatQueued | null {
    const entry = ref === undefined ? this.entries[0] : this.entries.find((each) => each.ref === ref)
    return entry ? { ...entry, images: [...entry.images] } : null
  }

  get view(): ChatQueued[] {
    return this.entries.map((entry) => ({ ...entry, images: [...entry.images] }))
  }

  // The first waiting message alone, as older clients read it.
  get first(): { text: string; held: boolean; images: ChatImage[] } | null {
    const [entry] = this.entries
    return entry ? { text: entry.text, held: entry.held, images: [...entry.images] } : null
  }
}
