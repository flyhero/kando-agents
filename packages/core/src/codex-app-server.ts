import { z } from 'zod'
import type { ChatDecision, ChatDiff, ChatModel, ChatTodo, ChatToolStatus, ChatTurnActivity, ChatTurnState } from '@kando/protocol'
import type { ChatAnswer, ChatDriver, ChatRecord, ChatStageOptions, StageMessage } from './chat-driver'
import { ChatItems, clip } from './chat-items'
import { StageState } from './chat-stage-state'
import { Rejection } from './rejection'

// Codex's app-server protocol (`codex app-server`): JSON-RPC over stdio without the jsonrpc field,
// as codex-cli 0.156.1 speaks it. `codex app-server generate-ts` prints the full schema; this reads
// only the part Kando uses, loosely, since the server is marked experimental.

const MAX_PATCH = 50_000
// The policy the Codex TUI starts with by default, stated outright: left out, a thread takes
// whatever config.toml says.
const APPROVAL_POLICY = 'on-request'
const SANDBOX = 'workspace-write'

const Id = z.union([z.string(), z.number()])
const Frame = z.looseObject({
  id: Id.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional()
})
type Frame = z.infer<typeof Frame>
const Item = z.looseObject({
  type: z.string(),
  id: z.string(),
  text: z.string().optional(),
  summary: z.array(z.string()).catch([]).optional(),
  content: z.array(z.unknown()).catch([]).optional(),
  command: z.string().optional(),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().nullish(),
  status: z.string().optional(),
  changes: z.array(z.looseObject({
    path: z.string(),
    kind: z.looseObject({ type: z.string() }).catch({ type: 'update' }),
    diff: z.string().catch('')
  })).catch([]).optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).nullish(),
  query: z.string().optional()
})
type Item = z.infer<typeof Item>
const ItemEvent = z.looseObject({ item: Item })
const Delta = z.looseObject({ itemId: z.string(), delta: z.string() })
const TurnEvent = z.looseObject({
  turn: z.looseObject({
    id: z.string(),
    status: z.string().optional(),
    error: z.looseObject({ message: z.string().optional() }).nullish(),
    durationMs: z.number().nullish()
  })
})
const ThreadEvent = z.looseObject({ thread: z.looseObject({ id: z.string() }) })
const SandboxShape = z.looseObject({ type: z.string() })
// What a thread was opened with, from the thread/start or thread/resume answer.
const ThreadOpened = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  approvalPolicy: z.unknown().optional(),
  sandbox: SandboxShape.optional().catch(undefined)
})
// What the thread runs with after a turn's overrides took effect.
const SettingsUpdated = z.looseObject({
  threadSettings: z.looseObject({
    approvalPolicy: z.unknown().optional(),
    sandboxPolicy: SandboxShape.optional().catch(undefined),
    model: z.string().nullish(),
    effort: z.string().nullish()
  })
})
const TokenUsage = z.looseObject({
  tokenUsage: z.looseObject({ last: z.looseObject({ totalTokens: z.number() }), modelContextWindow: z.number().nullish() })
})
const PlanUpdated = z.looseObject({ plan: z.array(z.looseObject({ step: z.string(), status: z.string() })).catch([]) })
const ModelEntry = z.looseObject({
  id: z.string(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string() })).catch([]).optional(),
  defaultReasoningEffort: z.string().nullish()
})
type ModelEntry = z.infer<typeof ModelEntry>
const ModelList = z.looseObject({ data: z.array(z.unknown()).catch([]) })
const ErrorEvent = z.looseObject({ error: z.looseObject({ message: z.string().optional() }).catch({}), willRetry: z.boolean().optional() })
const Resolved = z.looseObject({ requestId: Id })
const CommandApproval = z.looseObject({
  itemId: z.string().optional(),
  command: z.string().nullish(),
  reason: z.string().nullish(),
  availableDecisions: z.array(z.unknown()).nullish()
}).catch({})
const FileApproval = z.looseObject({ itemId: z.string().optional(), reason: z.string().nullish() }).catch({})
const UserInput = z.looseObject({
  questions: z.array(z.looseObject({
    id: z.string(),
    header: z.string().catch(''),
    question: z.string().catch(''),
    options: z.array(z.looseObject({ label: z.string(), description: z.string().nullish() })).nullish()
  })).catch([])
}).catch({ questions: [] })
const Decision = z.looseObject({ decision: z.unknown().optional(), answers: z.record(z.string(), z.unknown()).optional() })
const Answers = z.looseObject({ answers: z.array(z.string()).catch([]) })

type Pending = {
  kind: 'approval' | 'question'
  itemId: string
  // The JSON-RPC id exactly as the server sent it, number or string.
  rawId: string | number
  // What deny means here: decline where the server offers it, else cancel, which ends the turn.
  denial: 'decline' | 'cancel'
}

type Sandbox = 'workspace-write' | 'read-only' | 'danger-full-access'

// Kando's permission modes as Codex's approval policy and sandbox. acceptEdits is what the Codex
// TUI starts with: the sandbox lets it write the workspace, and it asks when it wants out.
export const CODEX_MODES: Record<string, { approvalPolicy: string; sandbox: Sandbox }> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  readOnly: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' }
}

// The protocol spells a sandbox in kebab case on a thread and as a tagged object in a policy.
function sandboxName(type: string | undefined): Sandbox | null {
  switch (type) {
    case 'workspace-write':
    case 'workspaceWrite':
      return 'workspace-write'
    case 'read-only':
    case 'readOnly':
      return 'read-only'
    case 'danger-full-access':
    case 'dangerFullAccess':
      return 'danger-full-access'
    default:
      return null
  }
}

// Kando's name for a policy and sandbox, or Codex's own words for a pairing it has no name for.
export function codexMode(approvalPolicy: unknown, sandbox: Sandbox | null): string | null {
  if (typeof approvalPolicy !== 'string' || !sandbox) return null
  const found = Object.entries(CODEX_MODES).find(([, mode]) => mode.approvalPolicy === approvalPolicy && mode.sandbox === sandbox)
  return found ? found[0] : `${approvalPolicy} · ${sandbox}`
}

const TODO_STATUS: Record<string, ChatTodo['status']> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' }

const DECISIONS: Record<string, 'allowed' | 'allowedForSession' | 'denied'> = {
  accept: 'allowed',
  acceptForSession: 'allowedForSession',
  decline: 'denied',
  cancel: 'denied'
}

// `/bin/zsh -lc 'cat x'` is how Codex runs `cat x`; the inner command is what the user reads.
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:bash|zsh|sh) -lc '([\s\S]*)'$/.exec(command)
  return match ? match[1]!.replaceAll(`'\\''`, `'`) : command
}

function toolStatus(status: string | undefined, exitCode: number | null | undefined): ChatToolStatus {
  switch (status) {
    case 'inProgress':
      return 'running'
    case 'declined':
      return 'denied'
    case 'failed':
      return 'failed'
    default:
      return exitCode !== null && exitCode !== undefined && exitCode !== 0 ? 'failed' : 'done'
  }
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// An added file comes as its content and a deleted one may too; an update is a unified diff already.
function diffOf(change: { path: string; kind: { type: string }; diff: string }): ChatDiff {
  const kind = change.kind.type === 'add' || change.kind.type === 'delete' ? change.kind.type : 'update'
  const looksLikeDiff = /^(@@|---|\+\+\+)/m.test(change.diff)
  const patch = kind === 'update' || looksLikeDiff
    ? change.diff
    : lines(change.diff).map((line) => `${kind === 'add' ? '+' : '-'}${line}`).join('\n')
  return { path: change.path, change: kind, patch: clip(patch, MAX_PATCH) }
}

function mcpOutput(item: Item): string | null {
  if (item.error?.message) return item.error.message
  const content = z.looseObject({ content: z.array(z.looseObject({ text: z.string().optional() })).catch([]) }).safeParse(item.result)
  const text = content.success ? content.data.content.map((part) => part.text ?? '').filter(Boolean).join('\n') : ''
  return text || null
}

export class CodexAppServer implements ChatDriver {
  readonly items: ChatItems
  // Kando's own requests by id, to know what each response answers.
  private readonly requests = new Map<string, string>()
  private initSent = false
  private initialized = false
  private initializedSent = false
  private threadRequested = false
  private threadId: string | null = null
  private startError: string | null = null
  private exited = false
  private turn: { ref: string; turnId: string | null; assistant: string | null } | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly unanswered = new Map<string, string | number>()
  private turns = 0
  private interrupts = 0
  private results = 0
  private messages: StageMessage[] = []
  private readonly state: StageState
  private modelsRequested = false
  private catalog: ModelEntry[] = []
  private model: string | null = null
  private effort: string | null = null
  private approvalPolicy: unknown = null
  private sandbox: Sandbox | null = null

  constructor(stageId: string, private readonly options: ChatStageOptions) {
    this.items = new ChatItems(stageId)
    this.state = new StageState(this.items)
  }

  apply(record: ChatRecord): void {
    switch (record.dir) {
      case 'in': {
        const frame = Frame.safeParse(record.frame)
        if (frame.success) this.receive(frame.data, record.at)
        break
      }
      case 'out': {
        const frame = Frame.safeParse(record.frame)
        if (frame.success) this.sent(frame.data, record.at, record.ref)
        break
      }
      case 'note':
        this.items.notice(record.level, record.text, record.at)
        break
      case 'exit':
        this.ended(record.stderr, record.at)
    }
    this.refreshOptions()
    this.state.publish(record.at)
  }

  due(): unknown[] {
    if (this.exited) return []
    const frames: unknown[] = [...this.unanswered.values()].map((id) => ({ id, error: { code: -32601, message: 'Kando does not handle this request' } }))
    if (!this.initSent) {
      frames.push({
        id: 'kando-init',
        method: 'initialize',
        params: { clientInfo: { name: 'kando', title: 'Kando', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }
      })
      return frames
    }
    if (!this.initialized || this.startError) return frames
    if (!this.initializedSent) frames.push({ method: 'initialized' })
    if (!this.threadRequested) frames.push(this.openThread())
    if (!this.modelsRequested) frames.push({ id: 'kando-models', method: 'model/list', params: {} })
    return frames
  }

  ready(): boolean {
    return this.threadId !== null && !this.exited
  }

  failure(): string | null {
    if (this.startError) return this.startError
    return this.exited && this.threadId === null ? 'exited' : null
  }

  activity(): ChatTurnActivity {
    if (!this.turn) return 'idle'
    return this.pending.size > 0 ? 'awaiting' : 'running'
  }

  providerSessionId(): string | null {
    return this.threadId
  }

  send(text: string): unknown {
    if (!this.ready() || !this.threadId) throw new Rejection('chat-starting', 'the agent is still starting')
    if (this.turn) throw new Rejection('chat-busy', 'the agent is still working on the last message')
    return {
      id: `kando-turn-${this.turns + 1}`,
      method: 'turn/start',
      params: {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: APPROVAL_POLICY,
        // The conversation's other projects are writable too, as --add-dir makes them in the TUI.
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [...this.options.extraDirs], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      }
    }
  }

  respond(requestId: string, answer: ChatAnswer): unknown[] {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Rejection('chat-request-gone', 'this request is no longer waiting for an answer')
    return [{ id: pending.rawId, result: this.answerBody(pending, answer) }]
  }

  interrupt(): unknown[] {
    if (!this.turn || !this.threadId) throw new Rejection('chat-idle', 'no turn is running')
    if (!this.turn.turnId) throw new Rejection('chat-busy', 'the turn has not started yet')
    const cancels = [...this.pending.values()].map((pending) => ({
      id: pending.rawId,
      result: pending.kind === 'question' ? { answers: {} } : { decision: 'cancel' }
    }))
    const request = { id: `kando-interrupt-${this.interrupts + 1}`, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.turn.turnId } }
    return [...cancels, request]
  }

  logged(frame: unknown): unknown | null {
    const parsed = Frame.safeParse(frame)
    if (!parsed.success) return null
    const { id, method } = parsed.data
    if (method === undefined) return this.loggedResponse(parsed.data)
    // Server requests are kept whole; of the notifications, only those that change what the chat shows.
    if (id !== undefined) return frame
    if (method === 'thread/settings/updated') {
      const update = SettingsUpdated.safeParse(parsed.data.params)
      if (!update.success) return null
      const { approvalPolicy, sandboxPolicy, model, effort } = update.data.threadSettings
      return { method, params: { threadSettings: { approvalPolicy, sandboxPolicy: sandboxPolicy ? { type: sandboxPolicy.type } : undefined, model, effort } } }
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = TokenUsage.safeParse(parsed.data.params)
      if (!usage.success) return null
      const { last, modelContextWindow } = usage.data.tokenUsage
      return { method, params: { tokenUsage: { last: { totalTokens: last.totalTokens }, modelContextWindow } } }
    }
    const kept = ['thread/started', 'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'serverRequest/resolved', 'error']
    return kept.includes(method) ? frame : null
  }

  takeMessages(): StageMessage[] {
    const messages = this.messages
    this.messages = []
    return messages
  }

  private loggedResponse(frame: Frame): unknown {
    if (frame.id === undefined || frame.error) return frame
    const method = this.requests.get(String(frame.id))
    const thread = ThreadOpened.safeParse(frame.result)
    if ((method === 'thread/start' || method === 'thread/resume') && thread.success) {
      const { model, reasoningEffort, approvalPolicy, sandbox } = thread.data
      return { id: frame.id, result: { thread: { id: thread.data.thread.id }, model, reasoningEffort, approvalPolicy, sandbox: sandbox ? { type: sandbox.type } : undefined } }
    }
    if (method === 'model/list') {
      const list = ModelList.safeParse(frame.result)
      return { id: frame.id, result: { data: list.success ? this.modelEntries(list.data.data) : [] } }
    }
    const turn = TurnEvent.safeParse(frame.result)
    if (method === 'turn/start' && turn.success) return { id: frame.id, result: { turn: { id: turn.data.turn.id } } }
    return method === 'initialize' ? { id: frame.id, result: {} } : frame
  }

  private modelEntries(data: readonly unknown[]): ModelEntry[] {
    return data.flatMap((raw) => {
      const entry = ModelEntry.safeParse(raw)
      if (!entry.success || entry.data.hidden) return []
      const { id, displayName, description, isDefault, supportedReasoningEfforts, defaultReasoningEffort } = entry.data
      return [{ id, displayName, description, isDefault, supportedReasoningEfforts, defaultReasoningEffort }]
    })
  }

  private refreshOptions(): void {
    const models: ChatModel[] = this.catalog.map((entry) => ({
      id: entry.id,
      label: entry.displayName ?? entry.id,
      description: entry.description ?? null,
      efforts: (entry.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
      isDefault: entry.isDefault ?? false
    }))
    const current = this.catalog.find((entry) => entry.id === this.model)
    this.state.set({
      models,
      model: this.model,
      // A thread on its model's default effort reports none.
      effort: this.effort ?? current?.defaultReasoningEffort ?? null,
      permissionMode: codexMode(this.approvalPolicy, this.sandbox),
      permissionModes: ['ask', 'acceptEdits', 'readOnly', ...(this.options.allowBypass ? ['bypass'] : [])]
    })
  }

  private openThread(): unknown {
    const { cwd, resume } = this.options
    const common = { cwd, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX }
    return resume
      ? { id: 'kando-thread', method: 'thread/resume', params: { threadId: resume, ...common, excludeTurns: true } }
      : { id: 'kando-thread', method: 'thread/start', params: common }
  }

  private answerBody(pending: Pending, answer: ChatAnswer): unknown {
    if (pending.kind === 'question') {
      const answers = answer.decision === 'deny' || !answer.answers ? {} : answer.answers
      return { answers: Object.fromEntries(Object.entries(answers).map(([question, labels]) => [question, { answers: labels }])) }
    }
    const decisions: Record<ChatDecision, string> = { allow: 'accept', allowForSession: 'acceptForSession', deny: pending.denial }
    return { decision: decisions[answer.decision] }
  }

  private receive(frame: Frame, at: number): void {
    if (frame.method !== undefined && frame.id !== undefined) return this.serverRequest(frame.method, frame.id, frame.params, at)
    if (frame.method !== undefined) return this.notification(frame.method, frame.params, at)
    if (frame.id !== undefined) this.response(frame, at)
  }

  private response(frame: Frame, at: number): void {
    const method = this.requests.get(String(frame.id))
    const error = frame.error ? (frame.error.message ?? `error ${frame.error.code ?? ''}`.trim()) : null
    if (method === 'initialize') {
      if (error) {
        this.startError = frame.error?.code === -32601 ? '当前 Codex 版本不支持聊天模式，请升级 Codex 或改用终端' : error
      } else {
        this.initialized = true
      }
    } else if (method === 'thread/start' || method === 'thread/resume') {
      const thread = ThreadOpened.safeParse(frame.result)
      if (thread.success) {
        this.threadId = thread.data.thread.id
        this.model = thread.data.model ?? this.model
        this.effort = thread.data.reasoningEffort ?? this.effort
        this.approvalPolicy = thread.data.approvalPolicy ?? this.approvalPolicy
        this.sandbox = sandboxName(thread.data.sandbox?.type) ?? this.sandbox
      } else {
        this.startError = error ?? 'Codex did not open a thread'
      }
    } else if (method === 'model/list') {
      const list = ModelList.safeParse(frame.result)
      if (list.success) this.catalog = this.modelEntries(list.data.data)
    } else if (method === 'turn/start') {
      const turn = TurnEvent.safeParse(frame.result)
      if (turn.success && this.turn && !this.turn.turnId) this.turn.turnId = turn.data.turn.id
      if (error) this.endTurn('failed', error, null, at)
    }
  }

  private notification(method: string, params: unknown, at: number): void {
    switch (method) {
      case 'thread/started': {
        const thread = ThreadEvent.safeParse(params)
        if (thread.success && !this.threadId) this.threadId = thread.data.thread.id
        return
      }
      case 'turn/started': {
        const turn = TurnEvent.safeParse(params)
        if (turn.success && this.turn && !this.turn.turnId) this.turn.turnId = turn.data.turn.id
        return
      }
      case 'turn/completed': {
        const turn = TurnEvent.safeParse(params)
        if (!turn.success) return
        const { status, error, durationMs } = turn.data.turn
        const state: ChatTurnState = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed'
        return this.endTurn(state, state === 'failed' ? (error?.message ?? null) : null, durationMs ?? null, at)
      }
      case 'item/started':
      case 'item/completed': {
        const event = ItemEvent.safeParse(params)
        if (event.success) this.item(event.data.item, method === 'item/completed', at)
        return
      }
      case 'item/agentMessage/delta': {
        const delta = Delta.safeParse(params)
        if (!delta.success) return
        // Made on the first delta rather than at item/started, which a replayed log also has: an
        // interrupted message then leaves no empty item behind.
        const id = `m:${delta.data.itemId}`
        if (!this.items.get(id)) this.items.put({ id, kind: 'assistant', text: '', streaming: true }, at)
        this.items.append(id, delta.data.delta)
        return
      }
      case 'thread/settings/updated': {
        const update = SettingsUpdated.safeParse(params)
        if (!update.success) return
        const { approvalPolicy, sandboxPolicy, model, effort } = update.data.threadSettings
        if (approvalPolicy !== undefined) this.approvalPolicy = approvalPolicy
        this.sandbox = sandboxName(sandboxPolicy?.type) ?? this.sandbox
        if (model) this.model = model
        if (effort !== undefined) this.effort = effort
        return
      }
      case 'thread/tokenUsage/updated': {
        const usage = TokenUsage.safeParse(params)
        if (usage.success) this.state.setContext({ used: usage.data.tokenUsage.last.totalTokens, window: usage.data.tokenUsage.modelContextWindow ?? null })
        return
      }
      case 'turn/plan/updated': {
        const plan = PlanUpdated.safeParse(params)
        if (!plan.success) return
        const todos = plan.data.plan.map((step) => ({ content: step.step, status: TODO_STATUS[step.status] ?? 'pending', activeForm: null }))
        this.state.setTodos(todos, this.turn?.ref ?? null, at)
        return
      }
      case 'serverRequest/resolved': {
        const resolved = Resolved.safeParse(params)
        if (resolved.success) this.resolve(String(resolved.data.requestId), 'cancelled', null, at)
        return
      }
      case 'error': {
        const event = ErrorEvent.safeParse(params)
        if (event.success) {
          this.items.notice(event.data.willRetry ? 'warning' : 'error', event.data.error.message ?? 'Codex reported an error', at)
        }
      }
    }
  }

  private item(item: Item, completed: boolean, at: number): void {
    const toolId = `t:${item.id}`
    switch (item.type) {
      case 'agentMessage': {
        if (!completed) return
        const text = item.text ?? ''
        this.items.put({ id: `m:${item.id}`, kind: 'assistant', text, streaming: false }, at)
        if (this.turn && text.trim()) this.turn.assistant = text
        return
      }
      case 'reasoning': {
        const text = [...(item.summary ?? []), ...(item.content ?? []).filter((part) => typeof part === 'string')].join('\n')
        if (completed && text.trim()) this.items.put({ id: `r:${item.id}`, kind: 'reasoning', text, streaming: false }, at)
        return
      }
      case 'commandExecution': {
        const command = item.command ?? ''
        this.items.put({
          id: toolId,
          kind: 'tool',
          name: 'commandExecution',
          title: unwrapShell(command),
          input: unwrapShell(command),
          status: completed ? toolStatus(item.status, item.exitCode) : 'running',
          output: item.aggregatedOutput ? clip(item.aggregatedOutput) : null,
          diffs: []
        }, at)
        return
      }
      case 'fileChange': {
        const changes = item.changes ?? []
        this.items.put({
          id: toolId,
          kind: 'tool',
          name: 'fileChange',
          title: changes.map((change) => change.path).join(', '),
          input: null,
          status: completed ? toolStatus(item.status, null) : 'running',
          output: null,
          diffs: changes.map(diffOf)
        }, at)
        return
      }
      case 'mcpToolCall': {
        const args = z.record(z.string(), z.unknown()).catch({}).parse(item.arguments ?? {})
        const first = Object.values(args).find((value) => typeof value === 'string')
        this.items.put({
          id: toolId,
          kind: 'tool',
          name: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`,
          title: typeof first === 'string' ? first.split('\n')[0]! : '',
          input: Object.keys(args).length ? clip(JSON.stringify(args, null, 2), 4000) : null,
          status: completed ? (item.error ? 'failed' : toolStatus(item.status, null)) : 'running',
          output: completed ? mcpOutput(item) : null,
          diffs: []
        }, at)
        return
      }
      case 'webSearch': {
        this.items.put({ id: toolId, kind: 'tool', name: 'webSearch', title: item.query ?? '', input: null, status: completed ? 'done' : 'running', output: null, diffs: [] }, at)
        return
      }
      case 'contextCompaction':
        if (completed) this.items.notice('info', '对话上下文已压缩', at)
    }
  }

  private serverRequest(method: string, rawId: string | number, params: unknown, at: number): void {
    const requestId = String(rawId)
    if (method === 'item/commandExecution/requestApproval') {
      const request = CommandApproval.parse(params)
      const offered = (request.availableDecisions ?? []).map((decision) => (typeof decision === 'string' ? decision : ''))
      const available = (decision: string) => request.availableDecisions == null || offered.includes(decision)
      const decisions: ChatDecision[] = ['allow', ...(available('acceptForSession') ? ['allowForSession' as const] : []), 'deny']
      this.approval(requestId, rawId, 'commandExecution', unwrapShell(request.command ?? ''), request.reason ?? null, request.itemId, decisions, available('decline') ? 'decline' : 'cancel', at)
    } else if (method === 'item/fileChange/requestApproval') {
      const request = FileApproval.parse(params)
      const tool = request.itemId ? this.items.get(`t:${request.itemId}`) : undefined
      const title = tool?.kind === 'tool' && tool.title ? tool.title : '修改文件'
      this.approval(requestId, rawId, 'fileChange', title, request.reason ?? null, request.itemId, ['allow', 'allowForSession', 'deny'], 'decline', at)
    } else if (method === 'item/tool/requestUserInput') {
      const request = UserInput.parse(params)
      const itemId = `q:${requestId}`
      const questions = request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? null })),
        multiSelect: false
      }))
      this.items.put({ id: itemId, kind: 'question', requestId, questions, answers: null, resolution: null }, at)
      this.pending.set(requestId, { kind: 'question', itemId, rawId, denial: 'cancel' })
    } else {
      this.unanswered.set(requestId, rawId)
    }
  }

  private approval(
    requestId: string,
    rawId: string | number,
    tool: string,
    title: string,
    detail: string | null,
    itemId: string | undefined,
    decisions: ChatDecision[],
    denial: 'decline' | 'cancel',
    at: number
  ): void {
    const approvalId = `a:${requestId}`
    this.items.put({
      id: approvalId,
      kind: 'approval',
      requestId,
      tool,
      title,
      detail,
      toolItemId: itemId ? `t:${itemId}` : null,
      decisions,
      resolution: null
    }, at)
    this.pending.set(requestId, { kind: 'approval', itemId: approvalId, rawId, denial })
  }

  private sent(frame: Frame, at: number, ref: string | undefined): void {
    if (frame.method !== undefined && frame.id !== undefined) {
      this.requests.set(String(frame.id), frame.method)
      if (frame.method === 'initialize') this.initSent = true
      if (frame.method === 'thread/start' || frame.method === 'thread/resume') this.threadRequested = true
      if (frame.method === 'model/list') this.modelsRequested = true
      if (frame.method === 'turn/interrupt') this.interrupts++
      if (frame.method === 'turn/start') this.startTurn(frame, at, ref)
      return
    }
    if (frame.method === 'initialized') {
      this.initializedSent = true
      return
    }
    if (frame.id === undefined) return
    const requestId = String(frame.id)
    if (this.unanswered.delete(requestId)) return
    const pending = this.pending.get(requestId)
    const decision = Decision.safeParse(frame.result)
    if (!pending || !decision.success) return
    if (pending.kind === 'question') {
      const answers = Object.fromEntries(Object.entries(decision.data.answers ?? {}).map(([question, value]) => [question, Answers.parse(value).answers]))
      this.resolve(requestId, Object.keys(answers).length ? 'answered' : 'cancelled', answers, at)
    } else {
      this.resolve(requestId, DECISIONS[String(decision.data.decision)] ?? 'denied', null, at)
    }
  }

  private startTurn(frame: Frame, at: number, ref: string | undefined): void {
    this.turns++
    const input = z.looseObject({ input: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([]) }).safeParse(frame.params)
    const text = input.success ? input.data.input.map((part) => part.text ?? '').join('\n') : ''
    const id = ref ?? `turn-${this.turns}`
    this.items.put({ id: `u:${id}`, kind: 'user', text }, at)
    this.turn = { ref: id, turnId: null, assistant: null }
    this.messages.push({ role: 'user', text, eventKey: `chat:${id}:user`, complete: false })
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

  private endTurn(state: ChatTurnState, error: string | null, durationMs: number | null, at: number): void {
    this.state.endTurn()
    for (const item of this.items.list()) {
      if (item.kind === 'assistant' && item.streaming) this.items.put({ ...item, streaming: false }, at)
    }
    for (const requestId of [...this.pending.keys()]) this.resolve(requestId, 'cancelled', null, at)
    const turn = this.turn
    this.items.put({ id: turn ? `turn:${turn.ref}` : `turn:result-${++this.results}`, kind: 'turn', state, error, durationMs }, at)
    if (turn?.assistant) {
      this.messages.push({ role: 'assistant', text: turn.assistant, eventKey: `chat:${turn.ref}:assistant`, complete: true })
    }
    this.turn = null
  }

  private ended(stderr: string, at: number): void {
    if (this.exited) return
    if (this.turn) this.endTurn('interrupted', 'agent 已退出', null, at)
    this.exited = true
    const tail = stderr.trim().split('\n').slice(-20).join('\n')
    if (this.threadId) return
    const unsupported = /unrecognized subcommand/i.test(stderr)
    const reason = unsupported ? '当前 Codex 版本不支持聊天模式，请升级 Codex 或改用终端' : (this.startError ?? tail)
    if (unsupported) this.startError = reason
    this.items.notice('error', `Codex 没能以聊天模式启动${reason ? `：\n${reason}` : ''}`, at)
  }
}
