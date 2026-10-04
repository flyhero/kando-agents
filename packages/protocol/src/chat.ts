import { z } from 'zod'
import { AttachmentId } from './attachments'

// idle: the agent waits for a message · running: a turn is under way · awaiting: the turn waits
// on the user to approve or answer something
export const ChatTurnActivity = z.enum(['idle', 'running', 'awaiting'])
export type ChatTurnActivity = z.infer<typeof ChatTurnActivity>

// The permission mode a scheduled run starts in, with nobody there to answer: edits go through
// (other calls may still ask), or nothing is asked and nothing sandboxed.
export const UNATTENDED_MODES = ['acceptEdits', 'bypass'] as const
export const UnattendedMode = z.enum(UNATTENDED_MODES)
export type UnattendedMode = z.infer<typeof UnattendedMode>

// How chats run on this machine, whichever window asks; core keeps them.
// promptSuggestions: after each turn the agent predicts the user's next message (Claude Code only).
// unattendedMode: see UnattendedMode; older cores leave it out.
export const ChatSettings = z.object({ promptSuggestions: z.boolean(), unattendedMode: UnattendedMode.optional() })
export type ChatSettings = z.infer<typeof ChatSettings>

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

// A slash command the agent offers: the composer sends it as the text `/name args`, and the
// driver passes it on in whatever form its agent takes.
export const ChatCommand = z.object({
  name: z.string(),
  description: z.string(),
  // What the command takes after its name ("[branch]"), or null when it takes nothing.
  argumentHint: z.string().nullable()
})
export type ChatCommand = z.infer<typeof ChatCommand>

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

// waiting: for the limit to lift, or for the user · retrying: the continue message is going out
// continued: it went out · cancelled: the user went on another way, or the chat cannot go on
export const USAGE_LIMIT_STATUSES = ['waiting', 'retrying', 'continued', 'cancelled'] as const
export type UsageLimitStatus = (typeof USAGE_LIMIT_STATUSES)[number]

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
    metrics: z.object({ tools: z.number(), tokens: z.number(), durationMs: z.number() }).nullable().optional(),
    // Images the call returned (a browser screenshot), from core's attachment store. Older cores leave it out.
    images: z.array(ChatImage).optional()
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
    resolution: z.enum(['allowed', 'allowedForSession', 'denied', 'cancelled']).catch('cancelled').nullable(),
    // A plan carried out: the permission mode it was carried out in. Older cores leave it out.
    mode: ChatPermissionMode.nullable().catch(null).optional()
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
    usage: z.union([
      z.object({ input: z.number(), output: z.number() }),
      z.object({ total: z.number() })
    ]).nullable().optional(),
    // The turn began on its own, when a subagent working in the background reported back, not
    // from a message. Older cores leave it out.
    resumed: z.boolean().optional(),
    // The agent's own name for where this turn ended, which a fork of the conversation can stop
    // at: Claude's id for the turn's last message, Codex's id for the turn. Older cores leave it out.
    providerRef: z.string().nullable().optional()
  }),
  Base.extend({ kind: z.literal('notice'), level: z.enum(['info', 'warning', 'error']).catch('info'), text: z.string() }),
  // The turn before it (turn:<ref> for limit:<ref>) failed because the account's usage limit was
  // reached. The agent's words come from the stage; what is done about it is core's, kept apart.
  Base.extend({
    kind: z.literal('usageLimit'),
    message: z.string().nullable(),
    // When the limit lifts, as the agent said or core's usage reading tells; null when neither can.
    resetsAt: z.number().nullable(),
    // Whether core sends the continue message itself once the limit lifts.
    autoContinue: z.boolean().default(false),
    status: z.enum(USAGE_LIMIT_STATUSES).catch('cancelled').default('cancelled'),
    // When core will try next, while it means to; when the continue message went out.
    continueAt: z.number().nullable().default(null),
    continuedAt: z.number().nullable().default(null),
    // Why the last try did not go through.
    error: z.string().nullable().default(null),
    // The scheduled run that continues it (schedules.list), while core has one. Older cores leave it out.
    runId: z.string().nullable().optional()
  }),
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
    // What the running turn has read and written so far, where the agent reports it as it goes;
    // null between turns and for an agent that reports only at the end. Older cores leave it out.
    turnUsage: z.object({ input: z.number(), output: z.number() }).nullable().default(null),
    // The first message waiting for the turn to end, for older clients; queue has them all.
    queued: z.object({ text: z.string(), held: z.boolean(), images: z.array(ChatImage).default([]) }).nullable(),
    queue: z.array(ChatQueued).default([]),
    // Whether the agent takes a message into a running turn (Claude Code does, Codex does not).
    steerable: z.boolean().default(false),
    // The slash commands the agent offers; older cores leave it out.
    commands: z.array(ChatCommand).default([])
  })
])
export type ChatItem = z.infer<typeof ChatItem>

// Kando's own tools, as each agent names an MCP tool: Claude Code mcp__<server>__<tool>, Codex
// <server>.<tool>. The server is `kando` in both launch configs.
export function kandoToolName(name: string): string | null {
  if (name.startsWith('mcp__kando__')) return name.slice('mcp__kando__'.length)
  if (name.startsWith('kando.')) return name.slice('kando.'.length)
  return null
}

// Shows the user a file the agent wrote, in the conversation: an HTML page or an SVG in a frame of
// its own, a picture (a screenshot, a chart it rendered) as an image.
export const SHOW_PREVIEW_TOOL = 'show_preview'
export const PREVIEW_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
export const PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'svg', ...PREVIEW_IMAGE_EXTENSIONS])
export function isPreviewImage(path: string): boolean {
  return PREVIEW_IMAGE_EXTENSIONS.has(path.split('.').at(-1)?.toLowerCase() ?? '')
}

// Codex's call that looks at a picture on disk (its view_image tool).
export const CODEX_IMAGE_VIEW = 'imageView'

// The picture a call looked at on disk, which the chat shows from where it is rather than from a
// copy: Claude's Read of an image file, Codex's imageView. null for any other call.
export function toolImagePath(item: { name: string; title: string }): string | null {
  const reads = item.name === 'Read' || item.name === CODEX_IMAGE_VIEW
  return reads && item.title.startsWith('/') && isPreviewImage(item.title) ? item.title : null
}
export function isPreviewTool(name: string): boolean {
  return kandoToolName(name) === SHOW_PREVIEW_TOOL
}

// The browser tools, named browser_<kind>.
export const BROWSER_TOOL_KINDS = ['navigate', 'snapshot', 'screenshot', 'click', 'type', 'press', 'hover', 'scroll', 'select', 'wait', 'tabs', 'console'] as const
export type BrowserToolKind = (typeof BROWSER_TOOL_KINDS)[number]
export function browserToolName(kind: BrowserToolKind): string {
  return `browser_${kind}`
}
export function browserToolKind(name: string): BrowserToolKind | null {
  const own = kandoToolName(name)
  if (!own?.startsWith('browser_')) return null
  const kind = own.slice('browser_'.length)
  const found = BROWSER_TOOL_KINDS.find((candidate) => candidate === kind)
  return found ?? null
}
export function isBrowserTool(name: string): boolean {
  return browserToolKind(name) !== null
}

// A Kando tool that returns an image also names its stored copy in a text block, one marker per
// image on a line of its own, so a driver can show it from the store and the log can leave the
// bytes out.
export function imageMarker(image: ChatImage): string {
  return `[kando-image ${image.id} ${image.width}x${image.height}]`
}
const IMAGE_MARKER = /^\[kando-image ([0-9a-f]{64}\.(?:png|jpg|gif|webp)) (\d+)x(\d+)\][ \t]*$/gm
// The images a tool's text names, and the text without the markers.
export function takeImageMarkers(text: string): { text: string; images: ChatImage[] } {
  const images: ChatImage[] = []
  const rest = text.replace(IMAGE_MARKER, (_line, id: string, width: string, height: string) => {
    images.push({ id, width: Number(width), height: Number(height) })
    return ''
  })
  return { text: images.length ? rest.replace(/\n{3,}/g, '\n\n').trim() : text, images }
}

// The notice either agent leaves where its context was compacted, which a client draws as a divider.
export const CONTEXT_COMPACTED = '对话上下文已压缩'

// A plan from plan mode waits as an approval: Claude's ExitPlanMode call, or the plan a Codex
// plan-mode turn ended with.
export const PLAN_TOOLS: ReadonlySet<string> = new Set(['ExitPlanMode', 'plan'])

// A plain check rather than a type guard: a plan has the approval type of any other approval.
export function isPlanApproval(item: ChatItem): boolean {
  return item.kind === 'approval' && PLAN_TOOLS.has(item.tool)
}

// Kando's own question, as an approval: the site its browser is about to open for the first time
// in this conversation. Not an agent tool, so the agent's names for tools never clash with it.
export const BROWSER_HOST_TOOL = 'browser_host'
export function isHostApproval(item: ChatItem): boolean {
  return item.kind === 'approval' && item.tool === BROWSER_HOST_TOOL
}
// Request ids Kando issues itself; an agent's never start this way, so an answer to one is
// routed to Kando rather than written to the agent.
export const KANDO_REQUEST_PREFIX = 'kando:'
export function isKandoRequest(requestId: string): boolean {
  return requestId.startsWith(KANDO_REQUEST_PREFIX)
}

// Parsed one by one, so an item a newer core describes differently drops alone, not the batch.
export const ChatItemList = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = ChatItem.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
)
