import type { ChatDecision, ChatImage, ChatOption, ChatTurnActivity } from '@kando/protocol'
import type { AttachmentFile } from './attachment-store'
import type { ChatItems } from './chat-items'

// What happened in a chat stage, in order: a frame from the agent or to it, a note Kando made,
// the process ending. A stage's log holds these, and replaying them rebuilds the stage.
export type ChatRecord =
  | { dir: 'in'; at: number; frame: unknown }
  // ref names the item an outgoing user message becomes, images what it showed the agent.
  | { dir: 'out'; at: number; frame: unknown; ref?: string; images?: ChatImage[] }
  | { dir: 'note'; at: number; level: 'info' | 'warning' | 'error'; text: string }
  // The user switched an option; an agent that takes options per turn applies it from here.
  | { dir: 'option'; at: number; option: ChatOption; value: string }
  // A message to wait for the turn to end (ref names its user item); text null with a ref drops
  // that one, or with release lets a held one go; text null alone drops them all.
  | { dir: 'queue'; at: number; text: string | null; ref?: string; images?: ChatImage[]; release?: boolean }
  | { dir: 'exit'; at: number; code: number | null; stderr: string }

// A user or final assistant message for conversation_messages. The key stays the same however
// often the stage is replayed, so each is stored once.
export type StageMessage = { role: 'user' | 'assistant'; text: string; eventKey: string; complete: boolean }

// The text conversation_messages keeps of a user message: the next agent, and a search, learn
// that images went with it, since neither can see them.
export function messageText(text: string, images: readonly ChatImage[]): string {
  if (images.length === 0) return text
  const note = `（附了 ${images.length} 张图片）`
  return text ? `${text}\n\n${note}` : note
}

// An image going with a message, as the store holds it: an agent takes the path, or the bytes.
export type ChatImageFile = ChatImage & AttachmentFile

// A message as the agent takes it, and as the log keeps it: the same, unless the message carries
// an image's bytes, which the log leaves out for the record's images.
export type ChatOutgoing = { wire: unknown; logged: unknown }

// saved: a plan kept for later rather than carried out. Core's own answer, never a client's.
export type ChatAnswer = { decision: ChatDecision; message?: string; answers?: Record<string, string[]>; saved?: boolean }

// Where and how a chat stage's agent works; the driver speaks for Kando within these bounds.
export type ChatStageOptions = {
  cwd: string
  // The conversation's other projects, which the agent may also write to.
  extraDirs: readonly string[]
  // The provider session (Claude session, Codex thread) to continue, if any.
  resume: string | null
  // Whether the user lets this conversation run with nothing asked and nothing sandboxed.
  allowBypass?: boolean
  // What the conversation last chose, for a stage that starts with it.
  preferred?: ChatPreferences
  // The stage may only plan: read-only in its folders, and its plan kept rather than carried out,
  // whatever the agent or a client asks.
  planOnly?: boolean
}

export type ChatPreferences = { permissionMode?: string; model?: string; effort?: string }

// Speaks one agent's JSON protocol. Everything it knows comes from apply(), so a live stage and one
// rebuilt from its log end up the same; the frames it asks for are sent (and logged) by the host.
export interface ChatDriver {
  readonly items: ChatItems
  apply(record: ChatRecord): void
  // Frames owed to the agent now: the handshake, answers to requests Kando does not handle.
  due(): unknown[]
  // The handshake is done and a message may be sent.
  ready(): boolean
  // Why the stage cannot start, once it is clear that it will not.
  failure(): string | null
  activity(): ChatTurnActivity
  providerSessionId(): string | null
  // Frames for the user's actions; each throws a Rejection when the stage cannot take it now.
  send(text: string, images?: readonly ChatImageFile[]): ChatOutgoing
  // A message into the running turn, for an agent that takes one (canSteer); a Rejection otherwise.
  steer(text: string, images?: readonly ChatImageFile[]): ChatOutgoing
  canSteer(): boolean
  respond(requestId: string, answer: ChatAnswer): unknown[]
  interrupt(): unknown[]
  // Frames that switch an option, after checking the stage offers the value (a Rejection if not).
  setOption(option: ChatOption, value: string): unknown[]
  // The queued message, once the agent is ready and idle to take it.
  queuedToSend(): { text: string; images: ChatImage[]; ref: string } | null
  // What of an incoming frame to keep in the log, or null for nothing: streamed deltas are
  // covered by the frames that complete them.
  logged(frame: unknown): unknown | null
  // Messages seen since the last call.
  takeMessages(): StageMessage[]
}
