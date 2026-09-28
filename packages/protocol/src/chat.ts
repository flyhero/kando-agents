import { z } from 'zod'

// tui: the agent's own interface in a terminal · chat: Kando renders its structured events
export const CONVERSATION_MODES = ['tui', 'chat'] as const
export const ConversationMode = z.enum(CONVERSATION_MODES)
export type ConversationMode = z.infer<typeof ConversationMode>

// idle: the agent waits for a message · running: a turn is under way · awaiting: the turn waits
// on the user to approve or answer something
export const ChatTurnActivity = z.enum(['idle', 'running', 'awaiting'])
export type ChatTurnActivity = z.infer<typeof ChatTurnActivity>

export const ChatToolStatus = z.enum(['running', 'done', 'failed', 'denied'])
export type ChatToolStatus = z.infer<typeof ChatToolStatus>

export const ChatTurnState = z.enum(['completed', 'interrupted', 'failed'])
export type ChatTurnState = z.infer<typeof ChatTurnState>

export const ChatDecision = z.enum(['allow', 'allowForSession', 'deny'])
export type ChatDecision = z.infer<typeof ChatDecision>

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

// Every item has a stable id; a newer revision of it replaces the one the client holds.
const Base = z.object({ id: z.string(), stageId: z.string(), revision: z.number().int(), at: z.number() })

export const ChatItem = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('user'), text: z.string() }),
  Base.extend({ kind: z.literal('assistant'), text: z.string(), streaming: z.boolean() }),
  Base.extend({ kind: z.literal('reasoning'), text: z.string(), streaming: z.boolean() }),
  Base.extend({
    kind: z.literal('tool'),
    // The agent's own tool name (Bash, Edit, commandExecution...); the UI labels the known ones.
    name: z.string(),
    // One line saying what the call does: a command, a path, a pattern.
    title: z.string(),
    input: z.string().nullable(),
    status: ChatToolStatus.catch('done'),
    output: z.string().nullable(),
    diffs: z.array(ChatDiff).default([])
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
    durationMs: z.number().nullable()
  }),
  Base.extend({ kind: z.literal('notice'), level: z.enum(['info', 'warning', 'error']).catch('info'), text: z.string() })
])
export type ChatItem = z.infer<typeof ChatItem>

// Parsed one by one, so an item a newer core describes differently drops alone, not the batch.
export const ChatItemList = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = ChatItem.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
)
