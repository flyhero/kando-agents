import type { ChatDecision, ChatImage, ChatItem, ChatOption, ChatPermissionMode, ChatTurnActivity } from '@kando/protocol'
import type { AttachmentFile } from './attachment-store'
import type { ChatItems } from './chat-items'
import type { UsageReport } from './usage-source'
import type { McpServer } from './agent-command'

// What happened in a chat stage, in order: a frame from the agent or to it, a note Kando made,
// the process ending. A stage's log holds these, and replaying them rebuilds the stage.
export type ChatRecord =
  | { dir: 'in'; at: number; frame: unknown }
  // ref names the item an outgoing user message becomes, images what it showed the agent.
  | { dir: 'out'; at: number; frame: unknown; ref?: string; images?: ChatImage[] }
  | {
      dir: 'note'
      at: number
      level: 'info' | 'warning' | 'error'
      text: string
      id?: string
      action?: { kind: 'retryCursorTurn'; userItemId: string } | null
    }
  // The user switched an option; an agent that takes options per turn applies it from here.
  | { dir: 'option'; at: number; option: ChatOption; value: string }
  // A message to wait for the turn to end (ref names its user item); text null with a ref drops
  // that one, or with release lets a held one go; text null alone drops them all.
  | { dir: 'queue'; at: number; text: string | null; ref?: string; images?: ChatImage[]; release?: boolean; held?: boolean }
  | { dir: 'exit'; at: number; code: number | null; stderr: string }
  // Kando asked the user something mid-chat (the site its browser may open), and what they answered.
  | { dir: 'ask'; at: number; requestId: string; ask: { kind: 'browser-host'; host: string; url: string } | { kind: 'terminal-run'; command: string; cwd: string } }
  | { dir: 'answer'; at: number; requestId: string; resolution: 'allowed' | 'allowedForSession' | 'denied' | 'cancelled'; message?: string }
  // The user answered a question the agent asked in passing (answers null: put it aside); what
  // they chose goes to the agent as a message of its own.
  | { dir: 'reply'; at: number; requestId: string; answers: Record<string, string[]> | null }

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
// choice: one of the approval's choices, which the driver turns into its decision.
export type ChatAnswer = { decision: ChatDecision; choice?: string; mode?: ChatPermissionMode; message?: string; answers?: Record<string, string[]>; saved?: boolean }

// Where and how a chat stage's agent works; the driver speaks for Kando within these bounds.
export type ChatStageOptions = {
  cwd: string
  mcp?: McpServer
  // The conversation's other projects, which the agent may also write to.
  extraDirs: readonly string[]
  // The provider session (Claude session, Codex thread) to continue, if any.
  resume: string | null
  // Where to stop taking `resume` over: the providerRef of the last turn to keep. The agent then
  // works in a session of its own from there, and the one resumed stays as it was.
  fork?: string | null
  // Whether the user lets this conversation run with nothing asked and nothing sandboxed.
  allowBypass?: boolean
  // What the conversation last chose, for a stage that starts with it.
  preferred?: ChatPreferences
  // The stage may only plan: read-only in its folders, and its plan kept rather than carried out,
  // whatever the agent or a client asks.
  planOnly?: boolean
  // Whether the agent, one that can, suggests the user's next message after each turn.
  promptSuggestions?: boolean
  // Stores an image a tool result carries in its bytes (base64), for the chat to show; null when it
  // cannot. Without it, such an image shows as a placeholder.
  keepImage?: (data: string) => ChatImage | null
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
  // A question the agent asked in passing, which nothing waits on: answered by a message rather
  // than through respond(). The text to send (null: put aside, nothing sent), or undefined when
  // the request is not one of those.
  replyByMessage?(requestId: string, answer: ChatAnswer): { text: string | null; answers: Record<string, string[]> | null } | undefined
  // Those questions still open, oldest first.
  asking?(): Array<Extract<ChatItem, { kind: 'question' }>>
  interrupt(): unknown[]
  // Plans waiting with no turn running, for an agent whose plan outlasts its turn (Codex).
  waitingPlans?(): string[]
  // Frames that switch an option, after checking the stage offers the value (a Rejection if not).
  setOption(option: ChatOption, value: string): unknown[]
  // Providers whose configuration responses acknowledge a switch, rather than just the write.
  optionResult?(frame: unknown): { pending: boolean; error: string | null }
  // The queued message, once the agent is ready and idle to take it.
  queuedToSend(): { text: string; images: ChatImage[]; ref: string } | null
  // What of an incoming frame to keep in the log, or null for nothing: streamed deltas are
  // covered by the frames that complete them.
  logged(frame: unknown): unknown | null
  // Messages seen since the last call.
  takeMessages(): StageMessage[]
  // What the agent reported about its limits since the last call. Only live frames carry it:
  // logged() keeps none, so a replayed stage never reports old numbers.
  takeUsage?(): UsageReport | null
  // What the agent predicts the user will type next, from the turn's end until the next message.
  suggestion?(): string | null
  // Frames that stop (or restart) the suggestions without restarting the agent.
  pauseSuggestions?(paused: boolean): unknown[]
}
