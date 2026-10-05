import { create } from 'zustand'
import type { ChatImage } from '@kando/protocol'

// A message left in a chat's input for the user to go on from, by something other than their
// typing: a fork before one of their messages puts that message here, unsent. Taken once, by the
// composer of that conversation when it shows.
export type ChatDraft = { text: string; images: readonly ChatImage[] }

const useDraftStore = create<Record<string, ChatDraft>>()(() => ({}))

export function offerDraft(conversationId: string, draft: ChatDraft): void {
  useDraftStore.setState({ [conversationId]: draft })
}

export function takeDraft(conversationId: string): ChatDraft | null {
  const draft = useDraftStore.getState()[conversationId] ?? null
  if (draft) useDraftStore.setState((s) => { const { [conversationId]: _taken, ...rest } = s; return rest }, true)
  return draft
}
