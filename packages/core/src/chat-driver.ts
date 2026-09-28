import type { ChatDecision, ChatOption, ChatTurnActivity } from '@kando/protocol'
import type { ChatItems } from './chat-items'

// What happened in a chat stage, in order: a frame from the agent or to it, a note Kando made,
// the process ending. A stage's log holds these, and replaying them rebuilds the stage.
export type ChatRecord =
  | { dir: 'in'; at: number; frame: unknown }
  // ref names the item an outgoing user message becomes.
  | { dir: 'out'; at: number; frame: unknown; ref?: string }
  | { dir: 'note'; at: number; level: 'info' | 'warning' | 'error'; text: string }
  // The user switched an option; an agent that takes options per turn applies it from here.
  | { dir: 'option'; at: number; option: ChatOption; value: string }
  // A message to send once the turn ends (ref names its user item), or null to drop it.
  | { dir: 'queue'; at: number; text: string | null; ref?: string }
  | { dir: 'exit'; at: number; code: number | null; stderr: string }

// A user or final assistant message for conversation_messages. The key stays the same however
// often the stage is replayed, so each is stored once.
export type StageMessage = { role: 'user' | 'assistant'; text: string; eventKey: string; complete: boolean }

export type ChatAnswer = { decision: ChatDecision; message?: string; answers?: Record<string, string[]> }

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
  send(text: string): unknown
  respond(requestId: string, answer: ChatAnswer): unknown[]
  interrupt(): unknown[]
  // Frames that switch an option, after checking the stage offers the value (a Rejection if not).
  setOption(option: ChatOption, value: string): unknown[]
  // The queued message, once the agent is ready and idle to take it.
  queuedToSend(): { text: string; ref: string } | null
  // What of an incoming frame to keep in the log, or null for nothing: streamed deltas are
  // covered by the frames that complete them.
  logged(frame: unknown): unknown | null
  // Messages seen since the last call.
  takeMessages(): StageMessage[]
}
