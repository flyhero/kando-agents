import { z } from 'zod'
import { browserToolKind, CONTEXT_COMPACTED, takeImageMarkers, type ChatDecision, type ChatDiff, type ChatImage, type ChatModel, type ChatOption, type ChatTodo, type ChatToolStatus, type ChatTurnActivity, type ChatTurnState } from '@kando/protocol'
import { describeBrowserTool, showBrowserInput } from './browser-tools'
import { stripImageBytes } from './image-frames'
import { KandoRequests } from './kando-requests'
import { messageText, type ChatAnswer, type ChatDriver, type ChatImageFile, type ChatOutgoing, type ChatPreferences, type ChatRecord, type ChatStageOptions, type StageMessage } from './chat-driver'
import { ChatItems, clip } from './chat-items'
import { ChatQueue } from './chat-queue'
import { StageState } from './chat-stage-state'
import { Rejection } from './rejection'
import { windowOf } from './codex-usage'
import { mergeUsageReports, type UsageReport } from './usage-source'

// Codex's app-server protocol (`codex app-server`): JSON-RPC over stdio without the jsonrpc field,
// as codex-cli 0.156.1 speaks it. `codex app-server generate-ts` prints the full schema; this reads
// only the part Kando uses, loosely, since the server is marked experimental.

const MAX_PATCH = 50_000

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
  // Codex's own reading of the command: each part a read, a listing, a search, or unknown.
  commandActions: z.array(z.looseObject({
    type: z.string(),
    name: z.string().nullish(),
    path: z.string().nullish(),
    query: z.string().nullish()
  })).catch([]).optional(),
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
  query: z.string().optional(),
  prompt: z.string().nullish(),
  receiverThreadIds: z.array(z.string()).catch([]).optional(),
  agentsStates: z.record(z.string(), z.looseObject({ status: z.string(), message: z.string().nullish() })).catch({}).optional()
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
const ThreadRef = z.looseObject({ threadId: z.string() })
const ChildTurn = z.looseObject({
  turn: z.looseObject({
    status: z.string().optional(),
    items: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([]).optional(),
    error: z.looseObject({ message: z.string().optional() }).nullish()
  })
})
const SandboxShape = z.looseObject({ type: z.string() })
// What a thread was opened with, from the thread/start or thread/resume answer.
// Codex's plan mode is a collaboration mode, set per turn beside the approval policy and sandbox.
const Collaboration = z.looseObject({ mode: z.string() }).nullish().catch(undefined)
const ThreadOpened = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  approvalPolicy: z.unknown().optional(),
  sandbox: SandboxShape.optional().catch(undefined),
  collaborationMode: Collaboration
})
// What the thread runs with after a turn's overrides took effect.
const SettingsUpdated = z.looseObject({
  threadSettings: z.looseObject({
    approvalPolicy: z.unknown().optional(),
    sandboxPolicy: SandboxShape.optional().catch(undefined),
    model: z.string().nullish(),
    effort: z.string().nullish(),
    collaborationMode: Collaboration
  })
})
const TurnParams = z.looseObject({
  approvalPolicy: z.unknown().optional(),
  sandboxPolicy: SandboxShape.optional().catch(undefined),
  collaborationMode: Collaboration
})
// last is one model call; total accumulates calls across the thread.
const TokenCount = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional()
})
const TokenUsage = z.looseObject({
  turnId: z.string().optional(),
  tokenUsage: z.looseObject({
    last: TokenCount,
    total: TokenCount.optional(),
    modelContextWindow: z.number().nullish()
  })
})
const LimitWindow = z.looseObject({ usedPercent: z.number(), windowDurationMins: z.number().nullish(), resetsAt: z.number().nullish() })
// A sparse rolling update: a null window has no news, not no window.
const RateLimits = z.looseObject({
  rateLimits: z.looseObject({
    limitId: z.string().nullish(),
    primary: LimitWindow.nullish().catch(null),
    secondary: LimitWindow.nullish().catch(null),
    planType: z.string().nullish().catch(null)
  })
})
// The plan's own limit, the one the usage endpoint reports; other metered limits are left out.
const PLAN_LIMIT_ID = 'codex'
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
// Of the effective config, only the model: the rest may hold secrets and stays out of the log.
const ConfigRead = z.looseObject({ config: z.looseObject({ model: z.string().nullish() }) })
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
  // A plan is Codex's last word on a plan-mode turn: it waits past the turn for the next one.
  kind: 'approval' | 'question' | 'plan'
  itemId: string
  // The JSON-RPC id exactly as the server sent it, number or string.
  rawId: string | number
  // What deny means here: decline where the server offers it, else cancel, which ends the turn.
  denial: 'decline' | 'cancel'
}

type Sandbox = 'workspace-write' | 'read-only' | 'danger-full-access'

// Kando's permission modes as Codex's approval policy and sandbox. acceptEdits is what the Codex
// TUI starts with: the sandbox lets it write the workspace, and it asks when it wants out. It may
// also reach the network, as Claude Code in the same mode does: closed, every install or fetch
// failed first and then asked to leave the sandbox anyway, and config.toml, where the TUI turns it
// on, is not read here.
type CodexMode = { approvalPolicy: string; sandbox: Sandbox; network?: boolean }
const DEFAULT_MODE: CodexMode = { approvalPolicy: 'on-request', sandbox: 'workspace-write', network: true }
export const CODEX_MODES: Record<string, CodexMode> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: DEFAULT_MODE,
  readOnly: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  // Plan mode keeps Codex to reading, with the sandbox to back it up. Last, so the policy and
  // sandbox alone read as readOnly (see codexMode).
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' }
}
const PLAN_MODE = 'plan'
const PLAN_SAVED = '计划已保存到任务里，等它依赖的任务完成后再执行。现在不要实现，也不要再修改计划，回复一句确认即可。'

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

function sandboxPolicy(sandbox: Sandbox, writableRoots: readonly string[], network: boolean): unknown {
  switch (sandbox) {
    case 'workspace-write':
      return { type: 'workspaceWrite', writableRoots: [...writableRoots], networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
  }
}

const TODO_STATUS: Record<string, ChatTodo['status']> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' }

const DECISIONS: Record<string, 'allowed' | 'allowedForSession' | 'denied'> = {
  accept: 'allowed',
  acceptForSession: 'allowedForSession',
  decline: 'denied',
  cancel: 'denied'
}

// The words of a command line as a POSIX shell reads its quoting, with nothing expanded; null
// when a quote is left open.
function shellWords(line: string): string[] | null {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) return null
      word = (word ?? '') + line.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let text = ''
      for (i++; i < line.length && line[i] !== '"'; i++) {
        // Within double quotes a backslash escapes only these; before anything else it stays.
        const next = line[i + 1]
        if (line[i] === '\\' && next !== undefined && '$`"\\\n'.includes(next)) i++
        text += line[i]
      }
      if (i >= line.length) return null
      word = (word ?? '') + text
    } else if (c === '\\') {
      word = (word ?? '') + (line[++i] ?? '')
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
    } else {
      word = (word ?? '') + c
    }
  }
  if (word !== null) words.push(word)
  return words
}

// `/bin/zsh -lc 'cat x'` is how Codex runs `cat x`, quoting the script whichever way suits it (not
// at all, in single quotes, in double quotes, or both run together); the script is what the user
// reads.
export function unwrapShell(command: string): string {
  const words = shellWords(command)
  if (words?.length !== 3) return command
  const [shell, flag, script] = words
  const wrapped = /^(?:\S*\/)?(?:bash|zsh|sh)$/.test(shell ?? '') && (flag === '-lc' || flag === '-c')
  return wrapped && script ? script : command
}

type CommandAction = NonNullable<Item['commandActions']>[number]

// What a command does in words, from Codex's own reading of it, but only when every part of it is
// a read of a named file, a listing of a named folder or a search for something: words that leave
// out what, as "列出文件" four times over, say less than the command itself.
export function commandDescription(actions: readonly CommandAction[] | undefined): string | null {
  if (!actions?.length) return null
  const parts: string[] = []
  let reads: string[] = []
  const flush = () => {
    if (reads.length) parts.push(`读取 ${reads.join('、')}`)
    reads = []
  }
  for (const action of actions) {
    if (action.type === 'read' && action.name) {
      reads.push(action.name)
      continue
    }
    flush()
    if (action.type === 'listFiles' && action.path) parts.push(`列出 ${action.path} 里的文件`)
    else if (action.type === 'search' && action.query) parts.push(`搜索「${action.query}」${action.path ? `（${action.path}）` : ''}`)
    else return null
  }
  flush()
  return parts.join('，')
}

// A subagent's state, as Codex reports it on the calls that deal with it. notFound says nothing.
const AGENT_STATUS: Record<string, ChatToolStatus> = {
  pendingInit: 'running',
  running: 'running',
  completed: 'done',
  errored: 'failed',
  interrupted: 'interrupted',
  shutdown: 'interrupted'
}
const TURN_AGENT_STATUS: Record<string, string> = { completed: 'completed', interrupted: 'interrupted', failed: 'errored' }

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

// An MCP result's text and the images it names (see imageMarker); the error's message when it failed.
function mcpResult(item: Item): { text: string | null; images: ChatImage[] } {
  if (item.error?.message) return { text: item.error.message, images: [] }
  const content = z.looseObject({ content: z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() })).catch([]) }).safeParse(item.result)
  const taken = takeImageMarkers(content.success ? content.data.content.map((part) => part.text ?? '').filter(Boolean).join('\n') : '')
  return { text: taken.text || null, images: taken.images }
}

export class CodexAppServer implements ChatDriver {
  readonly items: ChatItems
  private readonly kando: KandoRequests
  // Kando's own requests by id, to know what each response answers.
  private readonly requests = new Map<string, string>()
  private initSent = false
  private initialized = false
  private initializedSent = false
  private threadRequested = false
  private threadId: string | null = null
  // The subagents this thread sent off, by their own thread, to the call that spawned each.
  private readonly agents = new Map<string, string>()
  // What files a subagent's pending change touches, to name them when it asks to make it.
  private readonly childFiles = new Map<string, string>()
  private startError: string | null = null
  private exited = false
  private turn: { ref: string; turnId: string | null; assistant: string | null } | null = null
  // What this turn used, summed across its model calls.
  private turnUsage: { input: number; output: number } | { total: number } | null = null
  private threadUsage: z.infer<typeof TokenCount> | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly unanswered = new Map<string, string | number>()
  private turns = 0
  private interrupts = 0
  // The user asked the running turn to stop: calls that fail from here on were cut short.
  private stopping = false
  private results = 0
  private messages: StageMessage[] = []
  private readonly state: StageState
  private readonly queue = new ChatQueue()
  private modelsRequested = false
  private configRequested = false
  private catalog: ModelEntry[] = []
  // The model config.toml names, which a thread runs when none is chosen, over the catalog's default.
  private configModel: string | null = null
  private model: string | null = null
  private effort: string | null = null
  private approvalPolicy: unknown = null
  private sandbox: Sandbox | null = null
  // Whether the thread runs in Codex's plan mode, as the last turn set it or the thread reports.
  private planning = false
  // Rate limits reported since the host last took them.
  private usage: UsageReport | null = null
  // What the user chose, sent with every turn: Codex takes options per turn, not in between.
  private readonly chosen: ChatPreferences

  constructor(stageId: string, private readonly options: ChatStageOptions) {
    this.items = new ChatItems(stageId)
    this.kando = new KandoRequests(this.items)
    this.state = new StageState(this.items)
    // A stage that only plans runs every turn in plan mode, whatever was remembered.
    this.chosen = { ...options.preferred, ...(options.planOnly ? { permissionMode: PLAN_MODE } : {}) }
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
        if (frame.success) this.sent(frame.data, record.at, record.ref, record.images ?? [])
        break
      }
      case 'note':
        this.items.notice(record.level, record.text, record.at)
        break
      case 'option':
        this.choose(record.option, record.value)
        break
      case 'queue':
        this.queue.apply(record)
        break
      case 'exit':
        this.ended(record.stderr, record.at)
        break
      case 'ask':
      case 'answer':
        this.kando.apply(record)
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
    if (!this.configRequested) frames.push({ id: 'kando-config', method: 'config/read', params: { cwd: this.options.cwd } })
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
    if (this.kando.pending > 0) return 'awaiting'
    if (!this.turn) return [...this.pending.values()].some((pending) => pending.kind === 'plan') ? 'awaiting' : 'idle'
    return this.pending.size > 0 ? 'awaiting' : 'running'
  }

  providerSessionId(): string | null {
    return this.threadId
  }

  // A message while a plan waits carries on planning, in plan mode as before. Codex reads an
  // image from its path itself, so the frame is what the log keeps.
  send(text: string, images: readonly ChatImageFile[] = []): ChatOutgoing {
    if (!this.ready() || !this.threadId) throw new Rejection('chat-starting', 'the agent is still starting')
    if (this.turn) throw new Rejection('chat-busy', 'the agent is still working on the last message')
    const frame = this.turnStart(this.threadId, text, this.chosen.permissionMode, images)
    return { wire: frame, logged: frame }
  }

  // The app server takes a message only as a new turn; one for the running turn waits in the queue.
  steer(): ChatOutgoing {
    throw new Rejection('chat-no-steer', 'Codex takes no message into a running turn')
  }

  canSteer(): boolean {
    return false
  }

  private turnStart(threadId: string, text: string, permissionMode: string | undefined, images: readonly ChatImageFile[] = []): unknown {
    const input = [
      ...(text || images.length === 0 ? [{ type: 'text', text, text_elements: [] }] : []),
      ...images.map((image) => ({ type: 'localImage', path: image.path }))
    ]
    return {
      id: `kando-turn-${this.turns + 1}`,
      method: 'turn/start',
      params: { threadId, input, ...this.turnOptions(permissionMode) }
    }
  }

  queuedToSend(): { text: string; images: ChatImage[]; ref: string } | null {
    return this.ready() && !this.turn ? this.queue.next() : null
  }

  setOption(option: ChatOption, value: string): unknown[] {
    if (!this.ready()) throw new Rejection('chat-starting', 'the agent is still starting')
    const state = this.state.current
    if (option === 'permissionMode') {
      if (!state.permissionModes.includes(value)) throw new Rejection('chat-option-invalid', `this stage offers no permission mode ${value}`)
      return []
    }
    if (this.turn) throw new Rejection('chat-busy', 'the model and effort change between turns')
    if (option === 'model') {
      if (!state.models.some((model) => model.id === value)) throw new Rejection('chat-option-invalid', `Codex lists no model ${value}`)
      return []
    }
    const model = state.models.find((each) => each.id === state.model)
    if (!model?.efforts.includes(value)) throw new Rejection('chat-option-invalid', `the model takes no effort ${value}`)
    return []
  }

  respond(requestId: string, answer: ChatAnswer): unknown[] {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Rejection('chat-request-gone', 'this request is no longer waiting for an answer')
    if (pending.kind === 'plan') {
      if (!this.threadId || this.turn) throw new Rejection('chat-busy', 'the agent is still working on the last message')
      // Carrying the plan out is the next turn, out of plan mode, in the mode picked for it; sending
      // it back is one more plan-mode turn with the user's note, and so is keeping it for later.
      if (answer.saved) return [this.turnStart(this.threadId, PLAN_SAVED, PLAN_MODE)]
      if (answer.decision === 'deny') {
        return [this.turnStart(this.threadId, answer.message ? `继续规划：${answer.message}` : '继续规划：请完善这个计划后再给我。', PLAN_MODE)]
      }
      // Its checkout stays read-only however the plan is answered.
      if (this.options.planOnly) throw new Rejection('plan-only', 'this stage may only plan')
      return [this.turnStart(this.threadId, '按这个计划开始执行。', answer.decision === 'allowForSession' ? 'acceptEdits' : 'ask')]
    }
    return [{ id: pending.rawId, result: this.answerBody(pending, answer) }]
  }

  interrupt(): unknown[] {
    if (!this.turn || !this.threadId) throw new Rejection('chat-idle', 'no turn is running')
    if (!this.turn.turnId) throw new Rejection('chat-busy', 'the turn has not started yet')
    const cancels = [...this.pending.values()].filter((pending) => pending.kind !== 'plan').map((pending) => ({
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
    // Of a subagent's thread, only how each turn ended and the files it may ask to change.
    if (this.childThread(method, parsed.data.params)) {
      return method === 'turn/completed' || (method === 'item/started' && ItemEvent.safeParse(parsed.data.params).data?.item.type === 'fileChange') ? frame : null
    }
    if (method === 'thread/settings/updated') {
      const update = SettingsUpdated.safeParse(parsed.data.params)
      if (!update.success) return null
      const { approvalPolicy, sandboxPolicy, model, effort, collaborationMode } = update.data.threadSettings
      const collaboration = collaborationMode ? { mode: collaborationMode.mode } : undefined
      return { method, params: { threadSettings: { approvalPolicy, sandboxPolicy: sandboxPolicy ? { type: sandboxPolicy.type } : undefined, model, effort, collaborationMode: collaboration } } }
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = TokenUsage.safeParse(parsed.data.params)
      if (!usage.success) return null
      const { last, total, modelContextWindow } = usage.data.tokenUsage
      const counts = ({ totalTokens, inputTokens, outputTokens }: z.infer<typeof TokenCount>) => ({ totalTokens, inputTokens, outputTokens })
      return { method, params: { turnId: usage.data.turnId, tokenUsage: { last: counts(last), total: total ? counts(total) : undefined, modelContextWindow } } }
    }
    const kept = ['thread/started', 'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'serverRequest/resolved', 'error']
    return kept.includes(method) ? stripImageBytes(frame) : null
  }

  takeMessages(): StageMessage[] {
    const messages = this.messages
    this.messages = []
    return messages
  }

  takeUsage(): UsageReport | null {
    const usage = this.usage
    this.usage = null
    return usage
  }

  private loggedResponse(frame: Frame): unknown {
    if (frame.id === undefined || frame.error) return frame
    const method = this.requests.get(String(frame.id))
    const thread = ThreadOpened.safeParse(frame.result)
    if ((method === 'thread/start' || method === 'thread/resume') && thread.success) {
      const { model, reasoningEffort, approvalPolicy, sandbox, collaborationMode } = thread.data
      const collaboration = collaborationMode ? { mode: collaborationMode.mode } : undefined
      return { id: frame.id, result: { thread: { id: thread.data.thread.id }, model, reasoningEffort, approvalPolicy, sandbox: sandbox ? { type: sandbox.type } : undefined, collaborationMode: collaboration } }
    }
    if (method === 'model/list') {
      const list = ModelList.safeParse(frame.result)
      return { id: frame.id, result: { data: list.success ? this.modelEntries(list.data.data) : [] } }
    }
    if (method === 'config/read') return { id: frame.id, result: { config: { model: ConfigRead.safeParse(frame.result).data?.config.model ?? null } } }
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
    const configured = this.catalog.some((entry) => entry.id === this.configModel)
    const models: ChatModel[] = this.catalog.map((entry) => ({
      id: entry.id,
      label: entry.displayName ?? entry.id,
      description: entry.description ?? null,
      efforts: (entry.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
      isDefault: configured ? entry.id === this.configModel : (entry.isDefault ?? false)
    }))
    const current = this.catalog.find((entry) => entry.id === this.model)
    this.state.set({
      queued: this.queue.first,
      queue: this.queue.view,
      steerable: false,
      models,
      model: this.model,
      // A thread on its model's default effort reports none.
      effort: this.effort ?? current?.defaultReasoningEffort ?? null,
      permissionMode: this.planning ? PLAN_MODE : codexMode(this.approvalPolicy, this.sandbox),
      permissionModes: this.options.planOnly ? [PLAN_MODE] : ['ask', 'acceptEdits', PLAN_MODE, 'readOnly', ...(this.options.allowBypass ? ['bypass'] : [])]
    })
  }

  // The mode a turn runs in: what the user chose, if this stage may run it, else the TUI's default.
  // It is always stated outright: left out, a thread takes whatever config.toml says.
  private mode(chosen = this.chosen.permissionMode): CodexMode {
    const allowed = chosen !== 'bypass' || this.options.allowBypass
    return (chosen && allowed ? CODEX_MODES[chosen] : undefined) ?? DEFAULT_MODE
  }

  private turnOptions(permissionMode = this.chosen.permissionMode): Record<string, unknown> {
    const { approvalPolicy, sandbox, network = false } = this.mode(permissionMode)
    const plan = permissionMode === PLAN_MODE
    // Plan mode is set on each turn in it, and left once on the next turn out of it. Its settings
    // name the model outright, which the mode then takes over the turn's own.
    const model = this.chosen.model ?? this.model ?? this.catalog.find((entry) => entry.isDefault)?.id
    const collaboration = (plan || this.planning) && model
      ? { collaborationMode: { mode: plan ? PLAN_MODE : 'default', settings: { model, reasoning_effort: this.chosen.effort ?? this.effort ?? null, developer_instructions: null } } }
      : {}
    return {
      approvalPolicy,
      // The conversation's other projects are writable too, as --add-dir makes them in the TUI.
      sandboxPolicy: sandboxPolicy(sandbox, this.options.extraDirs, network),
      ...(this.chosen.model ? { model: this.chosen.model } : {}),
      ...(this.chosen.effort ? { effort: this.chosen.effort } : {}),
      ...collaboration
    }
  }

  // Shows the choice at once; the next turn carries it to Codex, and its settings update confirms it.
  private choose(option: ChatOption, value: string): void {
    this.chosen[option] = value
    if (option === 'model') this.model = value
    if (option === 'effort') this.effort = value
    if (option === 'permissionMode') this.showMode(value)
  }

  private showMode(permissionMode: string): void {
    const { approvalPolicy, sandbox } = this.mode(permissionMode)
    this.approvalPolicy = approvalPolicy
    this.sandbox = sandbox
    this.planning = permissionMode === PLAN_MODE
  }

  private openThread(): unknown {
    const { cwd, resume } = this.options
    const { approvalPolicy, sandbox } = this.mode()
    const common = { cwd, approvalPolicy, sandbox, ...(this.chosen.model ? { model: this.chosen.model } : {}) }
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
        // A thread opened for a plan-mode start is not in plan mode until its first turn says so.
        this.planning = thread.data.collaborationMode ? thread.data.collaborationMode.mode === PLAN_MODE : this.chosen.permissionMode === PLAN_MODE
      } else {
        this.startError = error ?? 'Codex did not open a thread'
      }
    } else if (method === 'model/list') {
      const list = ModelList.safeParse(frame.result)
      if (list.success) this.catalog = this.modelEntries(list.data.data)
    } else if (method === 'config/read') {
      this.configModel = ConfigRead.safeParse(frame.result).data?.config.model ?? null
    } else if (method === 'turn/start') {
      const turn = TurnEvent.safeParse(frame.result)
      if (turn.success && this.turn && !this.turn.turnId) this.turn.turnId = turn.data.turn.id
      if (error) this.endTurn('failed', error, null, at)
    }
  }

  // A subagent's thread streams on the connection Kando opened: its calls and replies are not this
  // chat's. Whether a request it made was resolved still is, as the request shows here.
  private childThread(method: string, params: unknown): string | null {
    if (!this.threadId || method === 'serverRequest/resolved') return null
    const thread = ThreadRef.safeParse(params)
    return thread.success && thread.data.threadId !== this.threadId ? thread.data.threadId : null
  }

  private childNotification(threadId: string, method: string, params: unknown, at: number): void {
    if (method === 'item/started') {
      const event = ItemEvent.safeParse(params)
      if (event.success && event.data.item.type === 'fileChange') {
        this.childFiles.set(event.data.item.id, (event.data.item.changes ?? []).map((change) => change.path).join(', '))
      }
      return
    }
    if (method !== 'turn/completed') return
    // A subagent the thread does not wait on is settled by its own turn's end.
    const turn = ChildTurn.safeParse(params)
    if (!turn.success) return
    const { status, items, error } = turn.data.turn
    const reply = (items ?? []).filter((item) => item.type === 'agentMessage' && item.text?.trim()).at(-1)?.text ?? null
    this.agentState(threadId, TURN_AGENT_STATUS[status ?? ''] ?? 'completed', status === 'failed' ? (error?.message ?? reply) : reply, at)
  }

  private notification(method: string, params: unknown, at: number): void {
    const child = this.childThread(method, params)
    if (child) return this.childNotification(child, method, params, at)
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
        const { approvalPolicy, sandboxPolicy, model, effort, collaborationMode } = update.data.threadSettings
        if (approvalPolicy !== undefined) this.approvalPolicy = approvalPolicy
        this.sandbox = sandboxName(sandboxPolicy?.type) ?? this.sandbox
        if (model) this.model = model
        if (effort !== undefined) this.effort = effort
        if (collaborationMode) this.planning = collaborationMode.mode === PLAN_MODE
        return
      }
      case 'account/rateLimits/updated': {
        const update = RateLimits.safeParse(params)
        if (!update.success) return
        const { limitId, primary, secondary, planType } = update.data.rateLimits
        if (limitId && limitId !== PLAN_LIMIT_ID) return
        const windows = [
          primary ? windowOf(primary.usedPercent, primary.windowDurationMins ?? null, primary.resetsAt, 'session') : null,
          secondary ? windowOf(secondary.usedPercent, secondary.windowDurationMins ?? null, secondary.resetsAt, 'weekly') : null
        ].filter((window) => window !== null)
        this.usage = mergeUsageReports(this.usage, { at, windows, plan: planType })
        return
      }
      case 'thread/tokenUsage/updated': {
        const usage = TokenUsage.safeParse(params)
        if (!usage.success) return
        const { last, total, modelContextWindow } = usage.data.tokenUsage
        const previous = this.threadUsage
        if (total) this.threadUsage = total
        this.state.setContext({ used: last.totalTokens, window: modelContextWindow ?? null })
        // A resumed thread may first replay usage from its previous turn.
        if (!this.turn || (usage.data.turnId && usage.data.turnId !== this.turn.turnId)) return
        const increment = (key: 'totalTokens' | 'inputTokens' | 'outputTokens'): number | undefined => {
          const current = total?.[key]
          const before = previous?.[key]
          return current !== undefined && before !== undefined && current >= before ? current - before : last[key]
        }
        const input = increment('inputTokens')
        const output = increment('outputTokens')
        if (input !== undefined && output !== undefined) {
          if (input === 0 && output === 0 && !this.turnUsage) return
          const before = this.turnUsage && 'input' in this.turnUsage ? this.turnUsage : null
          this.turnUsage = { input: (before?.input ?? 0) + input, output: (before?.output ?? 0) + output }
          this.state.set({ turnUsage: this.turnUsage })
        } else {
          const count = increment('totalTokens')
          if (count !== undefined && (count > 0 || this.turnUsage)) {
            const before = this.turnUsage
            this.turnUsage = { total: (before ? 'total' in before ? before.total : before.input + before.output : 0) + count }
            this.state.set({ turnUsage: null })
          }
        }
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
          description: commandDescription(item.commandActions),
          input: unwrapShell(command),
          status: completed ? this.settled(toolStatus(item.status, item.exitCode)) : 'running',
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
          status: completed ? this.settled(toolStatus(item.status, null)) : 'running',
          output: null,
          diffs: changes.map(diffOf)
        }, at)
        return
      }
      case 'mcpToolCall': {
        const args = z.record(z.string(), z.unknown()).catch({}).parse(item.arguments ?? {})
        const name = `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`
        const browser = browserToolKind(name)
        const first = Object.values(args).find((value) => typeof value === 'string')
        const result = completed ? mcpResult(item) : { text: null, images: [] }
        const earlier = this.items.get(toolId)
        const images = result.images.length ? result.images : earlier?.kind === 'tool' ? earlier.images : undefined
        this.items.put({
          id: toolId,
          kind: 'tool',
          name,
          title: browser ? describeBrowserTool(browser, args) : typeof first === 'string' ? first.split('\n')[0]! : '',
          input: Object.keys(args).length && (!browser || showBrowserInput(browser)) ? clip(JSON.stringify(args, null, 2), 4000) : null,
          status: completed ? this.settled(item.error ? 'failed' : toolStatus(item.status, null)) : 'running',
          output: result.text,
          diffs: [],
          ...(images?.length ? { images } : {})
        }, at)
        return
      }
      case 'plan': {
        if (!completed || !item.text?.trim()) return
        const requestId = `plan:${item.id}`
        this.items.put({
          id: `a:${requestId}`,
          kind: 'approval',
          requestId,
          tool: PLAN_MODE,
          title: '计划',
          detail: item.text,
          toolItemId: null,
          decisions: ['allow', 'allowForSession', 'deny'],
          resolution: null
        }, at)
        this.pending.set(requestId, { kind: 'plan', itemId: `a:${requestId}`, rawId: requestId, denial: 'decline' })
        return
      }
      case 'webSearch': {
        this.items.put({ id: toolId, kind: 'tool', name: 'webSearch', title: item.query ?? '', input: null, status: completed ? 'done' : 'running', output: null, diffs: [] }, at)
        return
      }
      case 'collabAgentToolCall': {
        if (item.tool === 'spawnAgent') return this.spawned(item, completed, at)
        // Waiting on, messaging or closing subagents shows as how each of them is doing.
        if (completed) {
          for (const [thread, state] of Object.entries(item.agentsStates ?? {})) this.agentState(thread, state.status, state.message ?? null, at)
        }
        return
      }
      case 'contextCompaction':
        if (completed) this.items.notice('info', CONTEXT_COMPACTED, at)
    }
  }

  // A subagent sent off as a call of its own, like Claude's Task: what it was told, and later what it
  // reported back.
  private spawned(item: Item, completed: boolean, at: number): void {
    const id = `t:${item.id}`
    const prompt = item.prompt ?? ''
    const receiver = item.receiverThreadIds?.[0]
    if (receiver) this.agents.set(receiver, id)
    const state = receiver ? item.agentsStates?.[receiver] : undefined
    const spawnFailed = completed && item.status !== 'completed'
    this.items.put({
      id,
      kind: 'tool',
      name: 'spawnAgent',
      title: prompt.split('\n')[0] ?? '',
      input: prompt ? clip(JSON.stringify({ prompt }), 4000) : null,
      status: spawnFailed ? this.settled(item.status === 'interrupted' ? 'interrupted' : 'failed') : (AGENT_STATUS[state?.status ?? ''] ?? 'running'),
      output: state?.message ?? null,
      diffs: []
    }, at)
  }

  private agentState(thread: string, status: string, message: string | null, at: number): void {
    const id = this.agents.get(thread)
    const tool = id ? this.items.get(id) : undefined
    const next = AGENT_STATUS[status]
    if (tool?.kind !== 'tool' || !next) return
    // Closing a subagent that had finished says it was shut down, which is no news of how it did.
    if (status === 'shutdown' && tool.status !== 'running') return
    this.items.put({ ...tool, status: this.settled(next), output: message ?? tool.output }, at)
  }

  private serverRequest(method: string, rawId: string | number, params: unknown, at: number): void {
    const requestId = String(rawId)
    if (method === 'item/commandExecution/requestApproval') {
      const request = CommandApproval.parse(params)
      const offered = (request.availableDecisions ?? []).map((decision) => (typeof decision === 'string' ? decision : ''))
      const available = (decision: string) => request.availableDecisions == null || offered.includes(decision)
      const decisions: ChatDecision[] = ['allow', ...(available('acceptForSession') ? ['allowForSession' as const] : []), 'deny']
      this.approval(requestId, rawId, 'commandExecution', unwrapShell(request.command ?? ''), this.requestDetail(method, params, request.reason ?? null), request.itemId, decisions, available('decline') ? 'decline' : 'cancel', at)
    } else if (method === 'item/fileChange/requestApproval') {
      const request = FileApproval.parse(params)
      const tool = request.itemId ? this.items.get(`t:${request.itemId}`) : undefined
      const title = tool?.kind === 'tool' && tool.title ? tool.title : ((request.itemId && this.childFiles.get(request.itemId)) || '修改文件')
      this.approval(requestId, rawId, 'fileChange', title, this.requestDetail(method, params, request.reason ?? null), request.itemId, ['allow', 'allowForSession', 'deny'], 'decline', at)
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

  // A subagent's request is the user's to answer too, in the chat that sent it off, said to be its.
  private requestDetail(method: string, params: unknown, reason: string | null): string | null {
    if (!this.childThread(method, params)) return reason
    return reason ? `子 agent 的请求：${reason}` : '子 agent 的请求'
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

  private sent(frame: Frame, at: number, ref: string | undefined, images: readonly ChatImage[]): void {
    if (frame.method !== undefined && frame.id !== undefined) {
      this.requests.set(String(frame.id), frame.method)
      if (frame.method === 'initialize') this.initSent = true
      if (frame.method === 'thread/start' || frame.method === 'thread/resume') this.threadRequested = true
      if (frame.method === 'model/list') this.modelsRequested = true
      if (frame.method === 'config/read') this.configRequested = true
      if (frame.method === 'turn/interrupt') {
        this.interrupts++
        if (this.turn) this.stopping = true
      }
      if (frame.method === 'turn/start') this.startTurn(frame, at, ref, images)
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

  private startTurn(frame: Frame, at: number, ref: string | undefined, images: readonly ChatImage[]): void {
    this.turns++
    this.turnUsage = null
    this.state.set({ turnUsage: null })
    const params = TurnParams.safeParse(frame.params)
    if (params.success) this.turnMode(params.data, at)
    const input = z.looseObject({ input: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).catch([]) }).safeParse(frame.params)
    const text = input.success ? input.data.input.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('\n') : ''
    const id = ref ?? `turn-${this.turns}`
    this.items.put({ id: `u:${id}`, kind: 'user', text, images: [...images] }, at)
    this.queue.sent(ref)
    this.turn = { ref: id, turnId: null, assistant: null }
    this.messages.push({ role: 'user', text: messageText(text, images), eventKey: `chat:${id}:user`, complete: false })
  }

  // A turn answers a waiting plan by the mode it runs in: plan mode keeps planning, any other
  // carries the plan out, and the conversation goes on in that mode. Read off the frame, so a
  // stage rebuilt from its log comes out the same.
  private turnMode(params: z.infer<typeof TurnParams>, at: number): void {
    if (params.collaborationMode) this.planning = params.collaborationMode.mode === PLAN_MODE
    const plans = [...this.pending].filter(([, pending]) => pending.kind === 'plan').map(([requestId]) => requestId)
    if (plans.length === 0) return
    const mode = this.planning ? PLAN_MODE : codexMode(params.approvalPolicy, sandboxName(params.sandboxPolicy?.type))
    if (mode && mode in CODEX_MODES) {
      this.chosen.permissionMode = mode
      this.showMode(mode)
    }
    const resolution = this.planning ? 'denied' : mode === 'acceptEdits' ? 'allowedForSession' : 'allowed'
    plans.forEach((requestId) => this.resolve(requestId, resolution, null, at))
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

  private settled(status: ChatToolStatus): ChatToolStatus {
    return status === 'failed' && this.stopping ? 'interrupted' : status
  }

  private endTurn(state: ChatTurnState, error: string | null, durationMs: number | null, at: number): void {
    if (state !== 'completed') this.items.settleTools(state, at)
    this.stopping = false
    this.state.endTurn()
    this.queue.turnEnded(state)
    for (const item of this.items.list()) {
      if (item.kind === 'assistant' && item.streaming) this.items.put({ ...item, streaming: false }, at)
    }
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.kind !== 'plan') this.resolve(requestId, 'cancelled', null, at)
    }
    const turn = this.turn
    this.items.put({ id: turn ? `turn:${turn.ref}` : `turn:result-${++this.results}`, kind: 'turn', state, error, durationMs, usage: this.turnUsage }, at)
    this.turnUsage = null
    this.state.set({ turnUsage: null })
    if (turn?.assistant) {
      this.messages.push({ role: 'assistant', text: turn.assistant, eventKey: `chat:${turn.ref}:assistant`, complete: true })
    }
    this.turn = null
  }

  private ended(stderr: string, at: number): void {
    if (this.exited) return
    if (this.turn) this.endTurn('interrupted', 'agent 已退出', null, at)
    // Subagents still at work go with the agent.
    this.items.settleTools('interrupted', at)
    // A plan left waiting goes with the agent; the next stage starts from its own messages.
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.kind === 'plan') this.resolve(requestId, 'cancelled', null, at)
    }
    this.kando.cancelAll(at)
    this.exited = true
    const tail = stderr.trim().split('\n').slice(-20).join('\n')
    if (this.threadId) return
    const unsupported = /unrecognized subcommand/i.test(stderr)
    const reason = unsupported ? '当前 Codex 版本不支持聊天模式，请升级 Codex 或改用终端' : (this.startError ?? tail)
    if (unsupported) this.startError = reason
    this.items.notice('error', `Codex 没能以聊天模式启动${reason ? `：\n${reason}` : ''}`, at)
  }
}
