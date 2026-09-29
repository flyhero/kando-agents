import type { Conversation } from '@kando/protocol'
import { useCore } from '../core-store'
import { conversationGlyph, conversationState } from '../conversation-state'
import { Spinner } from './Spinner'

const SPOKEN: Record<string, string> = { unseen: '有新动态' }

// The mark before a conversation's name: a spinner while its agent works, a coloured dot for what
// needs the user's eye, a ring when nothing does.
export function ConversationStatus({ conversation }: { conversation: Conversation }) {
  const unseen = useCore((s) => Boolean(s.unseen[conversation.id]))
  const glyph = conversationGlyph(conversation, unseen)
  const state = conversationState(conversation)
  const label = SPOKEN[glyph] ?? state.label
  return (
    <span className="conversation-status" data-glyph={glyph} role="img" aria-label={label} title={state.detail ?? label}>
      {glyph === 'running' && <Spinner />}
    </span>
  )
}
