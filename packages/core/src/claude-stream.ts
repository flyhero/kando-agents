import { z } from 'zod'
import type { ChatDiff, ChatModel, ChatOption, ChatTurnActivity, ChatTurnState } from '@kando/protocol'
import type { ChatAnswer, ChatDriver, ChatRecord, ChatStageOptions, StageMessage } from './chat-driver'
import { ChatItems, clip } from './chat-items'
import { ChatQueue } from './chat-queue'
import { StageState } from './chat-stage-state'
import { CLAUDE_TASK_TOOLS, ClaudeTasks } from './claude-tasks'
import { Rejection } from './rejection'

// Claude Code's stream-json protocol (`claude -p --input-format stream-json --output-format
// stream-json`), as Claude Code 2.1.282 speaks it. It is only partly documented, so every frame is
// read loosely and anything unrecognized is ignored rather than trusted.

const INIT_ID = 'kando-init'
const SETTINGS_ID = 'kando-settings'
const INTERRUPT_PREFIX = 'kando-interrupt-'
const OPTION_PREFIX = 'kando-option-'
const MAX_PATCH = 50_000
// Calls that are Claude Code's own machinery, or that another item already shows: no tool card.
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ToolSearch', ...CLAUDE_TASK_TOOLS])
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit'])
// Plan mode drafts its plan in a file of its own (~/.claude/plans/<name>.md) before proposing it.
const PLAN_FILE = /\/plans\/[^/]+\.md$/
// Claude Code's permission modes by Kando's names for them; manual is what newer versions call default.
const PERMISSION_MODES: Record<string, string> = {
  default: 'ask',
  manual: 'ask',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'bypass'
}
// And back: the mode set_permission_mode takes for each of Kando's names.
export const CLAUDE_MODE_NAMES: Record<string, string> = {
  ask: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypass: 'bypassPermissions'
}
const ONE_MILLION = 1_000_000

const Head = z.looseObject({ type: z.string() })
const Block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional()
})
type Block = z.infer<typeof Block>
const Blocks = z.array(z.unknown()).transform((blocks) => blocks.flatMap((block) => {
  const parsed = Block.safeParse(block)
  return parsed.success ? [parsed.data] : []
}))
const Subagent = z.string().nullish()
const SystemFrame = z.looseObject({
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  // task_summary: what the agent is doing right now, null once it stops.
  detail: z.string().nullish()
})
const ModelRow = z.looseObject({
  value: z.string(),
  resolvedModel: z.string().nullish(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  supportedEffortLevels: z.array(z.string()).catch([]).optional(),
  supportsAutoMode: z.boolean().optional()
})
type ModelRow = z.infer<typeof ModelRow>
const InitResponse = z.looseObject({
  current_permission_mode: z.string().optional(),
  models: z.array(z.unknown()).catch([]).optional()
})
const SettingsResponse = z.looseObject({ effective: z.looseObject({ effortLevel: z.string().nullish() }).optional() })
const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional()
})
const StreamFrame = z.looseObject({
  parent_tool_use_id: Subagent,
  event: z.looseObject({
    type: z.string(),
    index: z.number().optional(),
    message: z.looseObject({ id: z.string() }).optional(),
    content_block: Block.optional(),
    delta: z.looseObject({ type: z.string(), text: z.string().optional(), thinking: z.string().optional() }).optional()
  })
})
const AssistantFrame = z.looseObject({
  parent_tool_use_id: Subagent,
  message: z.looseObject({ id: z.string(), content: Blocks.catch([]), usage: Usage.optional().catch(undefined) })
})
const UserFrame = z.looseObject({
  parent_tool_use_id: Subagent,
  isReplay: z.boolean().optional(),
  message: z.looseObject({ content: z.union([z.string(), Blocks]).catch('') }),
  tool_use_result: z.unknown().optional()
})
const ResultFrame = z.looseObject({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().nullish(),
  terminal_reason: z.string().nullish(),
  errors: z.array(z.string()).nullish().catch(null),
  duration_ms: z.number().nullish(),
  // Every model the turn used, the main one and any the CLI ran for itself.
  modelUsage: z.record(z.string(), z.looseObject({ contextWindow: z.number().optional() })).optional().catch(undefined)
})
const Input = z.record(z.string(), z.unknown()).catch({})
const ControlRequest = z.looseObject({
  request_id: z.string(),
  request: z.looseObject({
    subtype: z.string(),
    tool_name: z.string().optional(),
    input: Input.optional(),
    tool_use_id: z.string().optional(),
    description: z.string().optional(),
    permission_suggestions: z.array(z.unknown()).catch([]).optional()
  })
})
const ControlResponse = z.looseObject({
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    error: z.string().optional(),
    response: z.unknown().optional()
  })
})
const ControlCancel = z.looseObject({ request_id: z.string() })
const Answered = z.looseObject({
  behavior: z.string(),
  // A denial that also stops the turn.
  interrupt: z.boolean().optional(),
  updatedInput: Input.optional(),
  updatedPermissions: z.array(z.unknown()).optional()
})
const OutgoingUser = z.looseObject({ message: z.looseObject({ content: z.string() }) })
const Questions = z.array(z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })).catch([])
})).catch([])
const Hunk = z.looseObject({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string())
})
const EditResult = z.looseObject({ type: z.string().optional(), structuredPatch: z.array(Hunk).catch([]).optional() })

type Pending = {
  kind: 'approval' | 'question'
  tool: string
  itemId: string
  toolItemId: string | null
  input: Record<string, unknown>
  suggestions: unknown[]
}

function modelRows(value: unknown): ModelRow[] {
  return (Array.isArray(value) ? value : []).flatMap((row) => {
    const parsed = ModelRow.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function firstLine(value: string, max = 200): string {
  const [line = ''] = value.split('\n')
  const more = line.length > max || value.includes('\n')
  return more ? `${line.slice(0, max)}…` : line
}

// One line saying what a call does, for the tool card and the approval asking about it.
export function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return firstLine(str(input.command) ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(input.file_path) ?? ''
    case 'NotebookEdit':
      return str(input.notebook_path) ?? ''
    case 'Glob':
    case 'Grep':
      return [str(input.pattern), str(input.path)].filter(Boolean).join(' · ')
    case 'WebFetch':
      return str(input.url) ?? ''
    case 'WebSearch':
      return str(input.query) ?? ''
    case 'Task':
    case 'Agent':
      return str(input.description) ?? ''
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} 项` : ''
    case 'ExitPlanMode':
      return '计划'
    default: {
      const first = Object.values(input).find((value) => typeof value === 'string')
      return typeof first === 'string' ? firstLine(first) : ''
    }
  }
}

// The input worth showing beside the title; file tools show a diff instead.
function inputText(name: string, input: Record<string, unknown>): string | null {
  if (name === 'Bash') return str(input.command)
  if (name === 'ExitPlanMode') return str(input.plan)
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(name)) return null
  return Object.keys(input).length ? clip(JSON.stringify(input, null, 2), 4000) : null
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

function editPatch(before: string, after: string): string {
  return ['@@', ...lines(before).map((line) => `-${line}`), ...lines(after).map((line) => `+${line}`)].join('\n')
}

function inputDiffs(name: string, input: Record<string, unknown>): ChatDiff[] {
  const path = str(input.file_path)
  if (!path) return []
  if (name === 'Write') {
    return [{ path, change: 'add', patch: clip(lines(String(input.content ?? '')).map((line) => `+${line}`).join('\n'), MAX_PATCH) }]
  }
  if (name === 'Edit') {
    return [{ path, change: 'update', patch: clip(editPatch(String(input.old_string ?? ''), String(input.new_string ?? '')), MAX_PATCH) }]
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const patch = input.edits
      .map((edit) => Input.parse(edit))
      .map((edit) => editPatch(String(edit.old_string ?? ''), String(edit.new_string ?? '')))
      .join('\n')
    return [{ path, change: 'update', patch: clip(patch, MAX_PATCH) }]
  }
  return []
}

// The hunks Claude Code applied, when the tool result carries them: better than the input's guess.
function resultDiffs(previous: ChatDiff[], raw: unknown): ChatDiff[] {
  const parsed = EditResult.safeParse(raw)
  const hunks = parsed.success ? (parsed.data.structuredPatch ?? []) : []
  const [first] = previous
  if (!first || hunks.length === 0) return previous
  const patch = hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n')
  const change = parsed.data?.type === 'create' ? 'add' : 'update'
  return [{ path: first.path, change, patch: clip(patch, MAX_PATCH) }]
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => Block.safeParse(block))
    .map((parsed) => (!parsed.success ? '' : parsed.data.type === 'image' ? '[图片]' : (parsed.data.text ?? '')))
    .filter(Boolean)
    .join('\n')
}

export class ClaudeStream implements ChatDriver {
  readonly items: ChatItems
  private initSent = false
  private initialized = false
  private initError: string | null = null
  private exited = false
  private sessionId: string | null
  private turn: { ref: string; assistant: string | null } | null = null
  private readonly pending = new Map<string, Pending>()
  // Control requests Kando does not handle, still owed an error reply.
  private readonly unanswered = new Set<string>()
  private readonly denied = new Set<string>()
  // Calls with no tool card of their own (see HIDDEN_TOOLS), and plan mode's drafts of its plan,
  // which the plan it proposes shows in full.
  private readonly hiddenCalls = new Set<string>()
  private readonly planDrafts = new Set<string>()
  // The user asked the running turn to stop: calls that fail from here on were cut short.
  private stopping = false
  // Blocks of each API message seen as complete frames, and the streamed text items they finish.
  private readonly blockCounts = new Map<string, number>()
  private readonly streaming = new Map<string, string[]>()
  private streamMessage: string | null = null
  private interrupts = 0
  private results = 0
  private messages: StageMessage[] = []
  private readonly state: StageState
  private readonly queue = new ChatQueue()
  private readonly tasks = new ClaudeTasks()
  private settingsSent = false
  // What the stage runs: the CLI's model catalog, the model it reports, and its context window.
  private catalog: ModelRow[] = []
  private reportedModel: string | null = null
  private contextWindow: number | null = null
  private permissionMode: string | null = null
  private effort: string | null = null
  // Option switches sent and not yet answered, by request id.
  private readonly optionRequests = new Map<string, { subtype: string; value: string }>()
  private optionsSent = 0

  constructor(stageId: string, private readonly options: ChatStageOptions) {
    this.items = new ChatItems(stageId)
    this.state = new StageState(this.items)
    this.sessionId = options.resume
  }

  apply(record: ChatRecord): void {
    switch (record.dir) {
      case 'in':
        this.receive(record.frame, record.at)
        break
      case 'out':
        this.sent(record.frame, record.at, record.ref)
        break
      case 'note':
        this.items.notice(record.level, record.text, record.at)
        break
      case 'queue':
        this.queue.set(record.text, record.ref)
        break
      case 'option':
        // Claude Code takes options through its own control requests, which the log also holds.
        break
      case 'exit':
        this.ended(record.code, record.stderr, record.at)
    }
    this.refreshOptions()
    this.state.publish(record.at)
  }

  due(): unknown[] {
    if (this.exited) return []
    const frames: unknown[] = []
    if (!this.initSent) {
      frames.push({ type: 'control_request', request_id: INIT_ID, request: { subtype: 'initialize' } })
    }
    for (const requestId of this.unanswered) {
      frames.push({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Kando does not handle this request' } })
    }
    // The effort is the one setting nothing else reports.
    if (this.initialized && !this.settingsSent) {
      frames.push({ type: 'control_request', request_id: SETTINGS_ID, request: { subtype: 'get_settings' } })
    }
    return frames
  }

  ready(): boolean {
    return this.initialized && !this.exited
  }

  failure(): string | null {
    if (this.initError) return this.initError
    return this.exited && !this.initialized ? 'exited' : null
  }

  activity(): ChatTurnActivity {
    if (!this.turn) return 'idle'
    return this.pending.size > 0 ? 'awaiting' : 'running'
  }

  providerSessionId(): string | null {
    return this.sessionId
  }

  send(text: string): unknown {
    if (!this.ready()) throw new Rejection('chat-starting', 'the agent is still starting')
    if (this.turn) throw new Rejection('chat-busy', 'the agent is still working on the last message')
    return { type: 'user', message: { role: 'user', content: text } }
  }

  respond(requestId: string, answer: ChatAnswer): unknown[] {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Rejection('chat-request-gone', 'this request is no longer waiting for an answer')
    return [this.reply(requestId, this.answerBody(pending, answer))]
  }

  interrupt(): unknown[] {
    if (!this.turn) throw new Rejection('chat-idle', 'no turn is running')
    // A denial with interrupt set ends the turn at the tool the agent is waiting on.
    const denials = [...this.pending].map(([requestId]) =>
      this.reply(requestId, { behavior: 'deny', message: 'The user interrupted the turn.', interrupt: true })
    )
    const request = { type: 'control_request', request_id: `${INTERRUPT_PREFIX}${this.interrupts + 1}`, request: { subtype: 'interrupt' } }
    return [...denials, request]
  }

  queuedToSend(): { text: string; ref: string } | null {
    return this.ready() && !this.turn ? this.queue.next() : null
  }

  setOption(option: ChatOption, value: string): unknown[] {
    if (!this.ready()) throw new Rejection('chat-starting', 'the agent is still starting')
    const state = this.state.current
    const request = (body: Record<string, unknown>) => [{ type: 'control_request', request_id: `${OPTION_PREFIX}${this.optionsSent + 1}`, request: body }]
    if (option === 'permissionMode') {
      // A mode switch mid-turn is fine: it governs the calls still to come.
      const mode = CLAUDE_MODE_NAMES[value]
      if (!mode || !state.permissionModes.includes(value)) throw new Rejection('chat-option-invalid', `this stage offers no permission mode ${value}`)
      return request({ subtype: 'set_permission_mode', mode })
    }
    if (this.turn) throw new Rejection('chat-busy', 'the model and effort change between turns')
    if (option === 'model') {
      if (!state.models.some((model) => model.id === value)) throw new Rejection('chat-option-invalid', `Claude Code lists no model ${value}`)
      return request({ subtype: 'set_model', model: value })
    }
    const model = state.models.find((each) => each.id === state.model)
    if (!model?.efforts.includes(value)) throw new Rejection('chat-option-invalid', `the model takes no effort ${value}`)
    return request({ subtype: 'apply_flag_settings', settings: { effortLevel: value } })
  }

  logged(frame: unknown): unknown | null {
    const head = Head.safeParse(frame)
    if (!head.success) return null
    switch (head.data.type) {
      case 'stream_event':
      case 'rate_limit_event':
      case 'keep_alive':
        return null
      case 'system': {
        const system = SystemFrame.safeParse(frame)
        if (!system.success) return null
        const { subtype, session_id, model, permissionMode } = system.data
        if (subtype === 'init') return { type: 'system', subtype, session_id, model, permissionMode }
        // A status frame names the permission mode only when it changed.
        if (subtype === 'status' && permissionMode) return { type: 'system', subtype, permissionMode }
        return subtype === 'compact_boundary' ? { type: 'system', subtype } : null
      }
      case 'user': {
        const user = UserFrame.safeParse(frame)
        return user.success && user.data.isReplay ? null : frame
      }
      case 'assistant': {
        // Signatures are opaque and large; the thinking text, when there is any, is what shows.
        const assistant = AssistantFrame.safeParse(frame)
        if (!assistant.success) return frame
        const content = assistant.data.message.content.map((block) =>
          block.type === 'thinking' ? { type: 'thinking', thinking: block.thinking ?? '' } : block
        )
        return { ...assistant.data, type: 'assistant', message: { ...assistant.data.message, content } }
      }
      case 'control_response': {
        // Only the answers to Kando's own requests matter; the CLI also echoes Kando's answers back.
        const response = ControlResponse.safeParse(frame)
        if (!response.success || !this.ownRequest(response.data.response.request_id)) return null
        const { subtype, request_id, error } = response.data.response
        return { type: 'control_response', response: { subtype, request_id, ...(error ? { error } : {}), ...this.keptAnswer(response.data.response) } }
      }
      default:
        return frame
    }
  }

  takeMessages(): StageMessage[] {
    const messages = this.messages
    this.messages = []
    return messages
  }

  private ownRequest(requestId: string): boolean {
    return requestId === INIT_ID || requestId === SETTINGS_ID || requestId.startsWith(INTERRUPT_PREFIX) || requestId.startsWith(OPTION_PREFIX)
  }

  // What of an answer to Kando's request to keep: the models and mode initialize reports (it also
  // carries the account, commands and more, none of which belongs in a log), and the effort.
  private keptAnswer(response: { request_id: string; response?: unknown }): { response?: unknown } {
    if (response.request_id === INIT_ID) {
      const init = InitResponse.safeParse(response.response)
      if (!init.success) return {}
      const models = modelRows(init.data.models).map(({ value, resolvedModel, displayName, description, supportedEffortLevels, supportsAutoMode }) =>
        ({ value, resolvedModel, displayName, description, supportedEffortLevels, supportsAutoMode }))
      return { response: { current_permission_mode: init.data.current_permission_mode, models } }
    }
    if (response.request_id === SETTINGS_ID) {
      const settings = SettingsResponse.safeParse(response.response)
      return settings.success ? { response: { effective: { effortLevel: settings.data.effective?.effortLevel ?? null } } } : {}
    }
    // An option switch answers with the mode it set, or nothing.
    return response.request_id.startsWith(OPTION_PREFIX) && response.response !== undefined ? { response: response.response } : {}
  }

  // The options the stage offers follow from the catalog, the model and the mode reported.
  private refreshOptions(): void {
    const models: ChatModel[] = this.catalog.filter((row) => row.value !== 'default').map((row) => ({
      id: row.value,
      label: row.displayName ?? row.value,
      description: row.description ?? null,
      efforts: row.supportedEffortLevels ?? [],
      isDefault: row.resolvedModel != null && row.resolvedModel === this.catalog.find((each) => each.value === 'default')?.resolvedModel
    }))
    const current = this.currentModel()
    this.state.set({
      queued: this.queue.view,
      models,
      model: current?.value ?? this.reportedModel,
      effort: this.effort,
      permissionMode: this.permissionMode,
      permissionModes: [
        'ask',
        'acceptEdits',
        'plan',
        ...(current?.supportsAutoMode ? ['auto'] : []),
        ...(this.options.allowBypass ? ['bypass'] : [])
      ]
    })
  }

  // The catalog row for the model the CLI says it runs, by alias or by the id an alias resolves to.
  // It says so only once a turn starts; until then, the model it was started with or its default.
  private currentModel(): ModelRow | undefined {
    const reported = this.reportedModel ?? this.options.preferred?.model ?? this.catalog.find((row) => row.value === 'default')?.resolvedModel
    if (!reported) return undefined
    const rows = this.catalog.filter((row) => row.value !== 'default')
    return rows.find((row) => row.value === reported) ?? rows.find((row) => row.resolvedModel === reported)
  }

  private reply(requestId: string, response: unknown): unknown {
    return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }
  }

  private answerBody(pending: Pending, answer: ChatAnswer): unknown {
    if (pending.kind === 'question') {
      if (answer.decision === 'deny' || !answer.answers) {
        return { behavior: 'deny', message: answer.message || 'The user declined to answer.' }
      }
      const answers = Object.fromEntries(Object.entries(answer.answers).map(([question, labels]) => [question, labels.join(', ')]))
      return { behavior: 'allow', updatedInput: { ...pending.input, answers } }
    }
    if (pending.tool === 'ExitPlanMode') {
      if (answer.decision === 'deny') {
        return { behavior: 'deny', message: answer.message ? `Keep planning. ${answer.message}` : 'Keep planning: revise the plan and present it again.' }
      }
      const mode = answer.decision === 'allowForSession' ? 'acceptEdits' : 'default'
      return { behavior: 'allow', updatedInput: pending.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] }
    }
    switch (answer.decision) {
      case 'allow':
        return { behavior: 'allow', updatedInput: pending.input }
      case 'allowForSession':
        return pending.suggestions.length
          ? { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions }
          : { behavior: 'allow', updatedInput: pending.input }
      case 'deny':
        return { behavior: 'deny', message: answer.message || 'The user declined this tool call.' }
    }
  }

  private receive(frame: unknown, at: number): void {
    const head = Head.safeParse(frame)
    if (!head.success) return
    switch (head.data.type) {
      case 'system':
        return this.system(frame, at)
      case 'stream_event':
        return this.stream(frame, at)
      case 'assistant':
        return this.assistant(frame, at)
      case 'user':
        return this.toolResults(frame, at)
      case 'result':
        return this.result(frame, at)
      case 'control_request':
        return this.controlRequest(frame, at)
      case 'control_response':
        return this.controlResponse(frame, at)
      case 'control_cancel_request': {
        const cancel = ControlCancel.safeParse(frame)
        if (cancel.success) this.resolve(cancel.data.request_id, 'cancelled', null, at)
      }
    }
  }

  private system(frame: unknown, at: number): void {
    const system = SystemFrame.safeParse(frame)
    if (!system.success) return
    const { subtype, session_id, model, permissionMode, detail } = system.data
    if (subtype === 'init' && session_id) this.sessionId = session_id
    if (subtype === 'init' && model) this.reportedModel = model
    if ((subtype === 'init' || subtype === 'status') && permissionMode) this.permissionMode = PERMISSION_MODES[permissionMode] ?? permissionMode
    if (subtype === 'task_summary') this.state.set({ activity: detail ?? null })
    if (subtype === 'compact_boundary') this.items.notice('info', '对话上下文已压缩', at)
  }

  private stream(frame: unknown, at: number): void {
    const parsed = StreamFrame.safeParse(frame)
    if (!parsed.success || parsed.data.parent_tool_use_id) return
    const { event } = parsed.data
    if (event.type === 'message_start') {
      this.streamMessage = event.message?.id ?? null
      return
    }
    // Only text streams into items. A tool card waits for its complete frame, which a replayed
    // log also has, so the approval asking about a call always lands right after it.
    const message = this.streamMessage
    if (!message || event.index === undefined) return
    const id = `c:${message}:${event.index}`
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      this.items.put({ id, kind: 'assistant', text: event.content_block.text ?? '', streaming: true }, at)
      this.streaming.set(message, [...(this.streaming.get(message) ?? []), id])
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      this.items.append(id, event.delta.text ?? '')
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      if (!this.items.get(id)) this.items.put({ id, kind: 'reasoning', text: '', streaming: true }, at)
      this.items.append(id, event.delta.thinking)
    }
  }

  private assistant(frame: unknown, at: number): void {
    const parsed = AssistantFrame.safeParse(frame)
    if (!parsed.success || parsed.data.parent_tool_use_id) return
    const { id: message, content, usage } = parsed.data.message
    // What the latest request sent is what the conversation now fills of the context.
    if (usage) {
      const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      this.state.setContext({ used, window: this.contextWindow ?? this.guessedWindow() })
    }
    for (const block of content) {
      // Each complete frame carries one block, in the order the stream indexed them.
      const index = this.blockCounts.get(message) ?? 0
      this.blockCounts.set(message, index + 1)
      const id = `c:${message}:${index}`
      if (block.type === 'text') {
        this.finishText(message, id, block.text ?? '', at)
      } else if (block.type === 'thinking') {
        const text = block.thinking ?? ''
        if (text.trim() || this.items.get(id)) this.items.put({ id, kind: 'reasoning', text, streaming: false }, at)
      } else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id) {
        this.toolUse(block, at)
      }
    }
  }

  // Replaces the text item the stream built for this block, or starts one when nothing streamed.
  private finishText(message: string, id: string, text: string, at: number): void {
    const open = this.streaming.get(message) ?? []
    const target = this.items.get(id) ? id : (open[0] ?? id)
    this.streaming.set(message, open.filter((each) => each !== target))
    this.items.put({ id: target, kind: 'assistant', text, streaming: false }, at)
    if (this.turn && text.trim()) this.turn.assistant = text
  }

  private toolUse(block: Block, at: number): void {
    const id = `t:${block.id}`
    const name = block.name ?? 'tool'
    if (HIDDEN_TOOLS.has(name)) {
      this.hiddenCalls.add(id)
      if (CLAUDE_TASK_TOOLS.has(name) && block.id) this.tasks.call(name, block.id, block.input)
      if (name === 'TodoWrite') this.state.setTodos(this.tasks.list(), this.turn?.ref ?? null, at)
      return
    }
    const input = Input.parse(block.input ?? {})
    if (this.permissionMode === 'plan' && FILE_TOOLS.has(name) && PLAN_FILE.test(str(input.file_path) ?? '')) {
      this.planDrafts.add(id)
      return
    }
    const previous = this.items.get(id)
    const earlier = previous?.kind === 'tool' ? previous : null
    this.items.put({
      id,
      kind: 'tool',
      name,
      title: describeClaudeTool(name, input),
      input: inputText(name, input),
      status: earlier?.status ?? 'running',
      output: earlier?.output ?? null,
      diffs: inputDiffs(name, input)
    }, at)
  }

  private toolResults(frame: unknown, at: number): void {
    const parsed = UserFrame.safeParse(frame)
    if (!parsed.success || parsed.data.isReplay || parsed.data.parent_tool_use_id) return
    const { content } = parsed.data.message
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const id = `t:${block.tool_use_id}`
      if (this.planDrafts.has(id)) continue
      if (this.hiddenCalls.has(id)) {
        this.tasks.result(block.tool_use_id, parsed.data.tool_use_result)
        this.state.setTodos(this.tasks.list(), this.turn?.ref ?? null, at)
        continue
      }
      const previous = this.items.get(id)
      const tool = previous?.kind === 'tool'
        ? previous
        : { id, kind: 'tool' as const, name: 'tool', title: '', input: null, status: 'running' as const, output: null, diffs: [] }
      const status = !block.is_error ? 'done' : this.denied.has(id) ? 'denied' : this.stopping ? 'interrupted' : 'failed'
      const output = resultText(block.content)
      this.items.put({
        id,
        kind: 'tool',
        name: tool.name,
        title: tool.title,
        input: tool.input,
        status,
        output: output ? clip(output) : null,
        diffs: status === 'done' ? resultDiffs(tool.diffs, parsed.data.tool_use_result) : tool.diffs
      }, at)
    }
  }

  private result(frame: unknown, at: number): void {
    const parsed = ResultFrame.safeParse(frame)
    if (!parsed.success) return
    const result = parsed.data
    const window = this.windowOf(result.modelUsage)
    if (window) {
      this.contextWindow = window
      const context = this.state.current.context
      if (context) this.state.setContext({ used: context.used, window })
    }
    const state: ChatTurnState = (result.terminal_reason ?? '').startsWith('aborted')
      ? 'interrupted'
      : result.is_error || (result.subtype && result.subtype !== 'success')
        ? 'failed'
        : 'completed'
    const error = state === 'failed' ? (str(result.result) ?? result.errors?.join('\n') ?? result.subtype ?? null) : null
    this.endTurn(state, error, result.duration_ms ?? null, at)
  }

  // The window of the model the stage runs; a turn's usage also lists models the CLI ran for itself.
  private windowOf(usage: Record<string, { contextWindow?: number }> | undefined): number | null {
    if (!usage) return null
    const model = this.currentModel()
    const names = [this.reportedModel, model?.resolvedModel, model?.value].filter((name): name is string => Boolean(name))
    const match = names.map((name) => usage[name]?.contextWindow).find((window) => typeof window === 'number')
    return match ?? null
  }

  // Before the first turn reports it: a 1M model says so in its name.
  private guessedWindow(): number | null {
    const names = [this.reportedModel, this.currentModel()?.value].filter((name): name is string => Boolean(name))
    return names.some((name) => name.includes('[1m]')) ? ONE_MILLION : null
  }

  private endTurn(state: ChatTurnState, error: string | null, durationMs: number | null, at: number): void {
    this.finishStreaming(at)
    if (state !== 'completed') this.items.settleTools(state, at)
    this.stopping = false
    this.state.endTurn()
    this.queue.turnEnded(state)
    for (const requestId of [...this.pending.keys()]) this.resolve(requestId, 'cancelled', null, at)
    const turn = this.turn
    const id = turn ? `turn:${turn.ref}` : `turn:result-${++this.results}`
    this.items.put({ id, kind: 'turn', state, error, durationMs }, at)
    if (turn?.assistant) {
      this.messages.push({ role: 'assistant', text: turn.assistant, eventKey: `chat:${turn.ref}:assistant`, complete: true })
    }
    this.turn = null
  }

  private finishStreaming(at: number): void {
    for (const ids of this.streaming.values()) {
      for (const id of ids) {
        const item = this.items.get(id)
        if (item?.kind === 'assistant') this.items.put({ ...item, streaming: false }, at)
      }
    }
    this.streaming.clear()
  }

  private controlRequest(frame: unknown, at: number): void {
    const parsed = ControlRequest.safeParse(frame)
    if (!parsed.success) return
    const { request_id: requestId, request } = parsed.data
    if (request.subtype !== 'can_use_tool') {
      this.unanswered.add(requestId)
      return
    }
    const tool = request.tool_name ?? 'tool'
    const input = request.input ?? {}
    const toolItemId = request.tool_use_id ? `t:${request.tool_use_id}` : null
    if (tool === 'AskUserQuestion') {
      const itemId = `q:${requestId}`
      const questions = Questions.parse(input.questions).map((question) => ({
        id: question.question,
        header: question.header ?? '',
        question: question.question,
        options: question.options.map((option) => ({ label: option.label, description: option.description ?? null })),
        multiSelect: question.multiSelect ?? false
      }))
      this.items.put({ id: itemId, kind: 'question', requestId, questions, answers: null, resolution: null }, at)
      this.pending.set(requestId, { kind: 'question', tool, itemId, toolItemId, input, suggestions: [] })
      return
    }
    const suggestions = request.permission_suggestions ?? []
    const itemId = `a:${requestId}`
    // A plan to approve: carry it out asking each edit (allow) or taking edits as they come
    // (allowForSession), or keep planning (deny).
    const plan = tool === 'ExitPlanMode'
    this.items.put({
      id: itemId,
      kind: 'approval',
      requestId,
      tool,
      title: describeClaudeTool(tool, input),
      detail: plan ? str(input.plan) : (str(request.description) ?? str(input.description)),
      toolItemId,
      decisions: plan || suggestions.length ? ['allow', 'allowForSession', 'deny'] : ['allow', 'deny'],
      resolution: null
    }, at)
    this.pending.set(requestId, { kind: 'approval', tool, itemId, toolItemId, input, suggestions })
  }

  private controlResponse(frame: unknown, at: number): void {
    const parsed = ControlResponse.safeParse(frame)
    if (!parsed.success) return
    const { request_id: requestId, subtype, error, response } = parsed.data.response
    const switched = this.optionRequests.get(requestId)
    if (switched) {
      this.optionRequests.delete(requestId)
      if (subtype !== 'success') {
        this.items.notice('warning', `没能切换：${error ?? '未知原因'}`, at)
      } else if (switched.subtype === 'set_model') {
        this.reportedModel = switched.value
      } else if (switched.subtype === 'apply_flag_settings') {
        this.effort = switched.value
      } else {
        this.permissionMode = PERMISSION_MODES[switched.value] ?? switched.value
      }
      return
    }
    if (requestId === SETTINGS_ID) {
      const settings = SettingsResponse.safeParse(response)
      if (subtype === 'success' && settings.success) this.effort = settings.data.effective?.effortLevel ?? null
      return
    }
    if (requestId !== INIT_ID) return
    if (subtype !== 'success') {
      this.initError = error ?? 'initialize failed'
      return
    }
    this.initialized = true
    const init = InitResponse.safeParse(response)
    if (!init.success) return
    this.catalog = modelRows(init.data.models)
    const mode = init.data.current_permission_mode
    if (mode) this.permissionMode = PERMISSION_MODES[mode] ?? mode
  }

  private sent(frame: unknown, at: number, ref: string | undefined): void {
    const head = Head.safeParse(frame)
    if (!head.success) return
    if (head.data.type === 'user') {
      const user = OutgoingUser.safeParse(frame)
      if (!user.success || !ref) return
      const text = user.data.message.content
      this.items.put({ id: `u:${ref}`, kind: 'user', text }, at)
      this.queue.sent(ref)
      this.turn = { ref, assistant: null }
      this.messages.push({ role: 'user', text, eventKey: `chat:${ref}:user`, complete: false })
      return
    }
    if (head.data.type === 'control_request') {
      const request = ControlRequest.safeParse(frame)
      if (request.data?.request_id === INIT_ID) this.initSent = true
      if (request.data?.request_id === SETTINGS_ID) this.settingsSent = true
      if (request.data?.request_id.startsWith(OPTION_PREFIX)) {
        this.optionsSent++
        const body = z.looseObject({ subtype: z.string(), mode: z.string().optional(), model: z.string().optional(), settings: z.looseObject({ effortLevel: z.string().optional() }).optional() }).safeParse(request.data.request)
        if (body.success) {
          const value = body.data.mode ?? body.data.model ?? body.data.settings?.effortLevel ?? ''
          this.optionRequests.set(request.data.request_id, { subtype: body.data.subtype, value })
        }
      }
      if (request.data?.request_id.startsWith(INTERRUPT_PREFIX)) {
        this.interrupts++
        if (this.turn) this.stopping = true
      }
      return
    }
    if (head.data.type !== 'control_response') return
    const response = ControlResponse.safeParse(frame)
    if (!response.success) return
    const { request_id: requestId, subtype } = response.data.response
    if (subtype === 'error') {
      this.unanswered.delete(requestId)
      return
    }
    const answered = Answered.safeParse(response.data.response.response)
    if (!answered.success) return
    const pending = this.pending.get(requestId)
    if (pending?.kind === 'question') {
      const answers = answered.data.behavior === 'allow' ? answered.data.updatedInput?.answers : undefined
      const chosen = answers && typeof answers === 'object'
        ? Object.fromEntries(Object.entries(answers).map(([question, label]) => [question, [String(label)]]))
        : null
      this.resolve(requestId, chosen ? 'answered' : 'cancelled', chosen, at)
    } else if (answered.data.behavior === 'allow' && pending?.tool === 'ExitPlanMode') {
      const setsMode = z.array(z.looseObject({ mode: z.string().optional() })).catch([]).parse(answered.data.updatedPermissions ?? [])
      this.resolve(requestId, setsMode.some((update) => update.mode === 'acceptEdits') ? 'allowedForSession' : 'allowed', null, at)
    } else if (answered.data.behavior === 'allow') {
      this.resolve(requestId, answered.data.updatedPermissions?.length ? 'allowedForSession' : 'allowed', null, at)
    } else if (answered.data.interrupt) {
      // Denied only because the user stopped the turn: nothing was decided about the call itself.
      if (this.turn) this.stopping = true
      this.resolve(requestId, 'cancelled', null, at)
    } else {
      if (pending?.toolItemId) this.denied.add(pending.toolItemId)
      this.resolve(requestId, 'denied', null, at)
    }
  }

  private resolve(
    requestId: string,
    resolution: 'allowed' | 'allowedForSession' | 'denied' | 'cancelled' | 'answered',
    answers: Record<string, string[]> | null,
    at: number
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    const item = this.items.get(pending.itemId)
    if (item?.kind === 'question') {
      this.items.put({ ...item, answers, resolution: resolution === 'answered' ? 'answered' : 'cancelled' }, at)
    } else if (item?.kind === 'approval') {
      this.items.put({ ...item, resolution: resolution === 'answered' ? 'allowed' : resolution }, at)
    }
  }

  private ended(code: number | null, stderr: string, at: number): void {
    if (this.exited) return
    if (this.turn) this.endTurn('interrupted', 'agent 已退出', null, at)
    this.finishStreaming(at)
    for (const requestId of [...this.pending.keys()]) this.resolve(requestId, 'cancelled', null, at)
    this.exited = true
    const tail = stderr.trim().split('\n').slice(-20).join('\n')
    if (!this.initialized) {
      this.items.notice('error', `Claude Code 没能以聊天模式启动${tail ? `：\n${tail}` : ''}`, at)
    } else if (code !== null && code !== 0 && code < 128 && tail) {
      this.items.notice('warning', `Claude Code 异常退出（code ${code}）：\n${tail}`, at)
    }
  }
}
