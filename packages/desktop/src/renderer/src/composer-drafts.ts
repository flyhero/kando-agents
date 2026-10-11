import { z } from 'zod'
import { ChatImage } from '@kando/protocol'
import type { MentionedText } from './chat-mentions'

// Unsent input belongs to the conversation it was written in. The new-conversation page has its
// own slot. Kept locally so changing pages, closing the window, or a renderer reload loses none of
// what the user has typed or attached; a successful send removes it. Images are kept by their ids
// in core's attachment store, which holds them already once uploaded.

const MentionTarget = z.object({
  kind: z.enum(['file', 'directory', 'project']),
  path: z.string(),
  relative: z.string().nullable()
})
const Mention = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  target: MentionTarget
})
// Drafts kept before images were have none.
const Draft = z.object({ text: z.string(), mentions: z.array(Mention), images: z.array(ChatImage).default([]) }).refine(
  (draft) => draft.mentions.every((mention) => mention.start <= mention.end && mention.end <= draft.text.length)
)
const Drafts = z.record(z.string(), Draft)

const STORAGE_KEY = 'kando.composer-drafts'
const NEW_CONVERSATION = 'new-conversation'
export type ComposerDraft = MentionedText & { images: readonly ChatImage[] }

export const EMPTY_DRAFT: ComposerDraft = { text: '', mentions: [], images: [] }

function keyOf(conversationId: string | null): string {
  return conversationId === null ? NEW_CONVERSATION : `conversation:${conversationId}`
}

function load(): Record<string, ComposerDraft> {
  try {
    const parsed = Drafts.safeParse(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

let drafts = load()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Storage full or blocked: the in-memory draft still survives page changes in this window.
  }
}

export function composerDraft(conversationId: string | null): ComposerDraft {
  return drafts[keyOf(conversationId)] ?? EMPTY_DRAFT
}

export function saveComposerDraft(conversationId: string | null, value: ComposerDraft): void {
  const key = keyOf(conversationId)
  if (value.text === '' && value.images.length === 0) {
    const { [key]: _removed, ...rest } = drafts
    drafts = rest
  } else {
    drafts = { ...drafts, [key]: value }
  }
  persist()
}
