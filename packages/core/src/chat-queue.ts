import type { ChatImage, ChatTurnState } from '@kando/protocol'

type Entry = { text: string; images: ChatImage[]; ref: string; held: boolean }

// One message the user wrote while the agent worked, sent once the turn is over. A turn that was
// interrupted or failed does not send it: it waits, held, for the user to send or drop it.
export class ChatQueue {
  private entry: Entry | null = null

  // A queue record: text to wait (replacing what waited), or null to drop it.
  set(text: string | null, ref: string | undefined, images: readonly ChatImage[] = []): void {
    this.entry = text === null || !ref ? null : { text, images: [...images], ref, held: false }
  }

  // The message went out as the user message with this ref.
  sent(ref: string | undefined): void {
    if (ref && this.entry?.ref === ref) this.entry = null
  }

  turnEnded(state: ChatTurnState): void {
    if (this.entry && state !== 'completed') this.entry = { ...this.entry, held: true }
  }

  next(): { text: string; images: ChatImage[]; ref: string } | null {
    return this.entry && !this.entry.held ? { text: this.entry.text, images: this.entry.images, ref: this.entry.ref } : null
  }

  get view(): { text: string; held: boolean; images: ChatImage[] } | null {
    return this.entry && { text: this.entry.text, held: this.entry.held, images: this.entry.images }
  }
}
