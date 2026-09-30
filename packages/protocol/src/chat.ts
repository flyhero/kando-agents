import { z } from 'zod'
import { AttachmentId } from './attachments'

// tui: the agent's own interface in a terminal · chat: Kando renders its structured events
export const CONVERSATION_MODES = ['tui', 'chat'] as const
export const ConversationMode = z.enum(CONVERSATION_MODES)
export type ConversationMode = z.infer<typeof ConversationMode>

// idle: the agent waits for a message · running: a turn is under way · awaiting: the turn waits
// on the user to approve or answer something
export const ChatTurnActivity = z.enum(['idle', 'running', 'awaiting'])
export type ChatTurnActivity = z.infer<typeof ChatTurnActivity>

// interrupted: the user stopped the turn while the call ran.
export const ChatToolStatus = z.enum(['running', 'done', 'failed', 'denied', 'interrupted'])
export type ChatToolStatus = z.infer<typeof ChatToolStatus>

export const ChatTurnState = z.enum(['completed', 'interrupted', 'failed'])
export type ChatTurnState = z.infer<typeof ChatTurnState>

export const ChatDecision = z.enum(['allow', 'allowForSession', 'deny'])
export type ChatDecision = z.infer<typeof ChatDecision>

// Kando's names for how freely an agent may act; each agent maps them onto its own settings and
// offers the ones it has. ask: confirm each call · acceptEdits: file edits go through (Codex:
// on-request) · plan: read and plan only · auto: the agent's own judgement · readOnly: a read-only
// sandbox · bypass: nothing asked, nothing sandboxed.
export const CHAT_PERMISSION_MODES = ['ask', 'acceptEdits', 'plan', 'auto', 'readOnly', 'bypass'] as const
export const ChatPermissionMode = z.enum(CHAT_PERMISSION_MODES)
export type ChatPermissionMode = z.infer<typeof ChatPermissionMode>

export const CHAT_OPTIONS = ['permissionMode', 'model', 'effort'] as const
export const ChatOption = z.enum(CHAT_OPTIONS)
export type ChatOption = z.infer<typeof ChatOption>

export const ChatTodo = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']).catch('pending'),
  // How the step reads while it is under way ("Writing tests").
  activeForm: z.string().nullable()
})
export type ChatTodo = z.infer<typeof ChatTodo>

export const ChatModel = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  // The reasoning efforts it takes, in the agent's own words; empty when it takes none.
  efforts: z.array(z.string()),
  isDefault: z.boolean()
})
export type ChatModel = z.infer<typeof ChatModel>

// What an agent offers a chat before one starts: the models it lists, its default among them.
export const ChatCatalog = z.object({ models: z.array(ChatModel) })
export type ChatCatalog = z.infer<typeof ChatCatalog>

// How much of the model's context the conversation fills, in tokens; window is null until known.
export const ChatContextUse = z.object({ used: z.number(), window: z.number().nullable() })
export type ChatContextUse = z.infer<typeof ChatContextUse>

// A file change as a unified-diff body: lines start with +, - or a space, hunks with @@.
export const ChatDiff = z.object({
  path: z.string(),
  change: z.enum(['add', 'update', 'delete']).catch('update'),
  patch: z.string()
})
export type ChatDiff = z.infer<typeof ChatDiff>

export const ChatQuestion = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().nullable() })),
  multiSelect: z.boolean()
})
export type ChatQuestion = z.infer<typeof ChatQuestion>

// An image sent with a message, from core's attachment store.
export const ChatImage = z.object({ id: AttachmentId, width: z.number().int().positive(), height: z.number().int().positive() })
export type ChatImage = z.infer<typeof ChatImage>

// A message waiting for the turn to end, in the order the user wrote them; held after an
// interrupted or failed turn until the user sends or drops it. ref names the user item it becomes.
export const ChatQueued = z.object({ ref: z.string(), text: z.string(), held: z.boolean(), images: z.array(ChatImage).default([]) })
export type ChatQueued = z.infer<typeof ChatQueued>

// Every item has a stable id; a newer revision of it replaces the one the client holds.
const Base = z.object({ id: z.string(), stageId: z.string(), revision: z.number().int(), at: z.number() })

export const ChatItem = z.discriminatedUnion('kind', [
  // steer: sent into a running turn rather than starting one; the agent took it mid-way.
  Base.extend({ kind: z.literal('user'), text: z.string(), images: z.array(ChatImage).default([]), steer: z.boolean().optional() }),
  Base.extend({ kind: z.literal('assistant'), text: z.string(), streaming: z.boolean() }),
  Base.extend({ kind: z.literal('reasoning'), text: z.string(), streaming: z.boolean() }),
  Base.extend({
    kind: z.literal('tool'),
    // The agent's own tool name (Bash, Edit, commandExecution...); the UI labels the known ones.
    name: z.string(),
    // One line saying what the call does: a command, a path, a pattern.
    title: z.string(),
    // The same in words, where there are some: as the agent put it (Claude's Bash description), or
    // as Kando reads Codex's own parse of the command. Older cores leave it out.
    description: z.string().nullable().optional(),
    input: z.string().nullable(),
    status: ChatToolStatus.catch('done'),
    output: z.string().nullable(),
    diffs: z.array(ChatDiff).default([]),
    // What a subagent did, once it reports back: its calls, tokens and time. Older cores leave it out.
    metrics: z.object({ tools: z.number(), tokens: z.number(), durationMs: z.number() }).nullable().optional()
  }),
  Base.extend({
    kind: z.literal('approval'),
    requestId: z.string(),
    tool: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    // The tool item this asks about, whose card shows the command or diff in full.
    toolItemId: z.string().nullable().default(null),
    // What the agent accepts as an answer here; deny is always among them.
    decisions: z.array(ChatDecision.catch('deny')),
    resolution: z.enum(['allowed', 'allowedForSession', 'denied', 'cancelled']).catch('cancelled').nullable()
  }),
  Base.extend({
    kind: z.literal('question'),
    requestId: z.string(),
    questions: z.array(ChatQuestion),
    // Question id to the chosen labels.
    answers: z.record(z.string(), z.array(z.string())).nullable(),
    resolution: z.enum(['answered', 'cancelled']).catch('cancelled').nullable()
  }),
  Base.extend({
    kind: z.literal('turn'),
    state: ChatTurnState.catch('completed'),
    error: z.string().nullable(),
    durationMs: z.number().nullable(),
    // Tokens the turn sent and received, where the agent reports them; older cores leave it out.
    usage: z.object({ input: z.number(), output: z.number() }).nullable().optional(),
    // The turn began on its own, when a subagent working in the background reported back, not
    // from a message. Older cores leave it out.
    resumed: z.boolean().optional()
  }),
  Base.extend({ kind: z.literal('notice'), level: z.enum(['info', 'warning', 'error']).catch('info'), text: z.string() }),
  // A turn's checklist as it last stood, where the turn first touched it.
  Base.extend({ kind: z.literal('todos'), todos: z.array(ChatTodo) }),
  // The stage as it stands now, one per stage and not part of the conversation's flow: the
  // composer reads it for the options it offers and the progress it shows.
  Base.extend({
    kind: z.literal('state'),
    // One of CHAT_PERMISSION_MODES, or the agent's own name for a mode Kando has none for.
    permissionMode: z.string().nullable(),
    permissionModes: z.array(z.string()),
    model: z.string().nullable(),
    models: z.array(ChatModel),
    effort: z.string().nullable(),
    context: ChatContextUse.nullable(),
    todos: z.array(ChatTodo),
    // What the agent says it is doing right now.
    activity: z.string().nullable(),
    // The first message waiting for the turn to end, for older clients; queue has them all.
    queued: z.object({ text: z.string(), held: z.boolean(), images: z.array(ChatImage).default([]) }).nullable(),
    queue: z.array(ChatQueued).default([]),
    // Whether the agent takes a message into a running turn (Claude Code does, Codex does not).
    steerable: z.boolean().default(false)
  })
])
export type ChatItem = z.infer<typeof ChatItem>

// The notice either agent leaves where its context was compacted, which a client draws as a divider.
export const CONTEXT_COMPACTED = '对话上下文已压缩'

// A plan from plan mode waits as an approval: Claude's ExitPlanMode call, or the plan a Codex
// plan-mode turn ended with.
export const PLAN_TOOLS: ReadonlySet<string> = new Set(['ExitPlanMode', 'plan'])

// A plain check rather than a type guard: a plan has the approval type of any other approval.
export function isPlanApproval(item: ChatItem): boolean {
  return item.kind === 'approval' && PLAN_TOOLS.has(item.tool)
}

// Parsed one by one, so an item a newer core describes differently drops alone, not the batch.
export const ChatItemList = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = ChatItem.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
)
