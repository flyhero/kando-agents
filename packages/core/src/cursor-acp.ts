import { z } from 'zod'
import { takeImageMarkers, type ChatImage, type ChatItem, type ChatModel, type ChatOption, type ChatPermissionMode, type ChatTurnActivity, type ChatTurnState } from '@kando/protocol'
import { ChatItems, clip } from './chat-items'
import { StageState } from './chat-stage-state'
import { ChatQueue } from './chat-queue'
import { KandoRequests } from './kando-requests'
import { markKeptImages, keepImageBlocks, stripImageBytes } from './image-frames'
import { messageText, type ChatAnswer, type ChatDriver, type ChatImageFile, type ChatOutgoing, type ChatRecord, type ChatStageOptions, type StageMessage } from './chat-driver'
import { Rejection } from './rejection'

export const CURSOR_MODES = { ask: 'agent', plan: 'plan', readOnly: 'ask' } as const
const Id = z.union([z.string(), z.number()])
const Frame = z.looseObject({ jsonrpc: z.literal('2.0').optional(), id: Id.optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.looseObject({ code: z.number(), message: z.string() }).optional() })
type Frame = z.infer<typeof Frame>
const OptionValue = z.looseObject({ value: z.string(), name: z.string(), description: z.string().nullish() })
const Config = z.looseObject({ id: z.string(), category: z.string().optional(), name: z.string(), currentValue: z.string(), options: z.array(z.union([OptionValue, z.looseObject({ group: z.string(), options: z.array(OptionValue) })])).catch([]) })
type Config = z.infer<typeof Config>
const Configs = z.looseObject({ configOptions: z.array(Config).optional() })
const ModelCatalog = z.looseObject({ models: z.array(z.looseObject({ value: z.string(), name: z.string(), configOptions: z.array(Config).catch([]) })) })
const Opened = Configs.extend({
  sessionId: z.string().optional(),
  modes: z.looseObject({ currentModeId: z.string(), availableModes: z.array(z.looseObject({ id: z.string(), name: z.string(), description: z.string().nullish() })) }).optional(),
  models: z.looseObject({ currentModelId: z.string(), availableModels: z.array(z.looseObject({ modelId: z.string(), name: z.string(), description: z.string().nullish() })) }).optional()
})
const Initialized = z.looseObject({
  protocolVersion: z.union([z.literal(1), z.literal('1')]),
  agentCapabilities: z.looseObject({ loadSession: z.boolean().optional(), promptCapabilities: z.looseObject({ image: z.boolean().optional() }).optional(), sessionCapabilities: z.looseObject({ additionalDirectories: z.boolean().optional() }).optional() }).optional(),
  authMethods: z.array(z.looseObject({ id: z.string() })).optional()
})
const Content = z.looseObject({ type: z.string(), text: z.string().optional(), data: z.string().optional() })
const Update = z.looseObject({
  sessionUpdate: z.string(), content: z.unknown().optional(), toolCallId: z.string().optional(), title: z.string().optional(), kind: z.string().optional(),
  status: z.string().optional(), rawInput: z.unknown().optional(), rawOutput: z.unknown().optional(), locations: z.array(z.looseObject({ path: z.string() })).optional(),
  entries: z.array(z.looseObject({ content: z.string(), status: z.string() })).optional(), currentModeId: z.string().optional(), configOptions: z.array(Config).optional(),
  availableCommands: z.array(z.looseObject({ name: z.string(), description: z.string(), input: z.looseObject({ hint: z.string().optional() }).nullish() })).optional()
})
const Permission = z.looseObject({ toolCall: Update.omit({ sessionUpdate: true }), options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })).min(1) })
const Questions = z.looseObject({ title: z.string().optional(), toolCallId: z.string(), questions: z.array(z.looseObject({ id: z.string(), prompt: z.string(), allowMultiple: z.boolean().optional(), options: z.array(z.looseObject({ id: z.string(), label: z.string() })).catch([]) })).min(1) })
const Plan = z.looseObject({ toolCallId: z.string(), plan: z.string(), name: z.string().optional(), overview: z.string().optional() })
const Prompt = z.looseObject({ sessionId: z.string(), prompt: z.array(Content) })
const keyOf = (id: string | number) => `${typeof id}:${id}`
const rpc = (id: string | number, method: string, params: unknown) => ({ jsonrpc: '2.0', id, method, params })
const result = (id: string | number, body: unknown) => ({ jsonrpc: '2.0', id, result: body })
const valuesOf = (config: Config): z.infer<typeof OptionValue>[] => config.options.flatMap((option) => {
  const single = OptionValue.safeParse(option)
  if (single.success) return [single.data]
  return z.looseObject({ options: z.array(OptionValue) }).safeParse(option).data?.options ?? []
})
const kandoMode = (mode: string): ChatPermissionMode | null => mode === 'agent' ? 'ask' : mode === 'plan' ? 'plan' : mode === 'ask' ? 'readOnly' : null
const nativeMode = (mode: string) => mode === 'ask' ? 'agent' : mode === 'readOnly' ? 'ask' : mode
const PermissionOutcome = z.looseObject({ outcome: z.looseObject({ outcome: z.string(), optionId: z.string().optional() }) })
type Pending = { rawId: string | number; itemId: string; kind: 'permission' | 'question' | 'plan'; options?: z.infer<typeof Permission>['options'] }
type Request = { method: string; params: unknown }
type ThoughtLevel = { id: string; name: string; values: z.infer<typeof OptionValue>[] }

// Every transition comes from a log record, including outbound frames. Reattaching to a live
// daemon process therefore restores pending requests without repeating the handshake.
export class CursorAcp implements ChatDriver {
  readonly items: ChatItems
  private readonly state: StageState
  private readonly kando: KandoRequests
  private readonly queue = new ChatQueue()
  private readonly requests = new Map<string, Request>()
  private readonly optionErrors = new Map<string, string>()
  private readonly pending = new Map<string, Pending>()
  private readonly owed = new Map<string, unknown>()
  private readonly initial = new Map<string, unknown>()
  private initialChoices: Array<{ option: ChatOption; value: string }> = []
  private readonly kept = new Map<string, unknown>()
  private initialized = false
  private authenticated = false
  private initSent = false
  private authSent = false
  private sessionSent = false
  private modelsSent = false
  private modelsRead = false
  private models: ChatModel[] = []
  // Reasoning is per model and often absent from the session snapshot. The catalog names the option.
  private readonly thoughts = new Map<string, ThoughtLevel>()
  private setup = false
  private auth = false
  private load = false
  private images = false
  private directories = false
  private session: string | null = null
  private exited = false
  private startError: string | null = null
  private config: Config[] = []
  private modern = new Set<string>()
  private serial = 0
  private turns = 0
  private stopping = false
  private turn: { id: string; ref: string; began: number; text: string; block: string | null; blocks: number } | null = null
  private messages: StageMessage[] = []
  private execution: { text: string; images: ChatImage[]; ref: string } | null = null

  constructor(private readonly stageId: string, private readonly options: ChatStageOptions, private readonly catalogOnly = false) {
    this.items = new ChatItems(stageId)
    this.state = new StageState(this.items)
    this.kando = new KandoRequests(this.items)
  }

  apply(record: ChatRecord): void {
    if (record.dir === 'in' || record.dir === 'out') {
      const parsed = Frame.safeParse(record.frame)
      if (parsed.success) {
        if (record.dir === 'in') this.receive(parsed.data, record.at)
        else this.sent(parsed.data, record.at, record.ref, record.images ?? [])
      }
    } else if (record.dir === 'queue') {
      if (record.text === null && record.ref === this.execution?.ref) this.execution = null
      this.queue.apply(record)
    } else if (record.dir === 'note') this.items.notice(record.level, record.text, record.at, {
      ...(record.id !== undefined ? { id: record.id } : {}),
      ...(record.action !== undefined ? { action: record.action } : {})
    })
    else if (record.dir === 'ask' || record.dir === 'answer') this.kando.apply(record)
    else if (record.dir === 'exit') {
      this.exited = true
      this.kando.cancelAll(record.at)
      this.cancelPending(record.at)
      this.finish(this.stopping ? 'interrupted' : 'failed', this.startError ?? (record.stderr.trim() || 'Cursor 进程已退出'), record.at)
    }
    this.state.set({ queued: this.queue.first, queue: this.queue.view, steerable: false })
    this.state.publish(record.at)
  }

  due(): unknown[] {
    if (this.exited) return []
    const frames = [...this.owed.values()]
    if (this.startError) return frames
    if (!this.initSent) return [...frames, rpc('cursor-init', 'initialize', { protocolVersion: 1, clientInfo: { name: 'kando', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } } })]
    if (!this.initialized) return frames
    if (this.auth && !this.authenticated) return this.authSent ? frames : [...frames, rpc('cursor-auth', 'authenticate', { methodId: 'cursor_login' })]
    const models = this.modelsSent ? [] : [rpc('cursor-models', 'cursor/list_available_models', {})]
    if (this.catalogOnly) return this.modelsRead ? frames : [...frames, ...models]
    if (!this.sessionSent) {
      if (this.options.resume && !this.load) { this.startError = '此 Cursor CLI 不支持恢复会话，请升级'; return frames }
      if (this.options.extraDirs.length && !this.directories) { this.startError = '此 Cursor CLI 不支持附加项目目录'; return frames }
      const mcp = this.options.mcp
      return [...frames, rpc('cursor-session', this.options.resume ? 'session/load' : 'session/new', {
        cwd: this.options.cwd,
        ...(this.options.resume ? { sessionId: this.options.resume } : {}),
        ...(this.options.extraDirs.length ? { additionalDirectories: this.options.extraDirs } : {}),
        mcpServers: mcp ? [{ name: 'kando', command: mcp.command, args: mcp.args, env: [] }] : []
      })]
    }
    // Asked once the session is open, the catalog takes about a second; asked first, it also
    // waits out the CLI's own startup. The saved choices wait for it: it names reasoning levels.
    if (!this.setup) return frames
    if (!this.modelsRead) return [...frames, ...models]
    return [...frames, ...this.initial.values()].filter((frame) => {
      const id = Frame.safeParse(frame).data?.id
      return id === undefined || !this.requests.has(keyOf(id))
    })
  }

  ready(): boolean { return this.session !== null && this.setup && this.modelsRead && this.initial.size === 0 && !this.startError && !this.exited }
  failure(): string | null { return this.startError ?? (this.exited && !this.session ? 'Cursor 进程已退出' : null) }
  activity(): ChatTurnActivity { return this.pending.size || this.kando.pending ? 'awaiting' : this.turn || this.changing() ? 'running' : 'idle' }
  providerSessionId(): string | null { return this.session }
  canSteer(): boolean { return false }
  steer(): ChatOutgoing { throw new Rejection('chat-no-steer', 'Cursor ACP 不支持向正在执行的回合追加消息') }
  queuedToSend() { return this.ready() && !this.turn && !this.changing() ? this.execution ?? this.queue.next() : null }
  takeMessages(): StageMessage[] { const taken = this.messages; this.messages = []; return taken }

  send(text: string, images: readonly ChatImageFile[] = []): ChatOutgoing {
    if (!this.ready()) throw new Rejection('chat-starting', 'Cursor 尚未就绪')
    if (this.turn) throw new Rejection('chat-busy', 'Cursor 正在处理上一条消息')
    if (this.changing()) throw new Rejection('chat-option-changing', '请等待 Cursor 确认配置变更')
    if (images.length && !this.images) throw new Rejection('chat-images-unsupported', '此 Cursor CLI 不支持图片输入')
    const base = { sessionId: this.session, prompt: [{ type: 'text', text }] }
    const logged = rpc(`cursor-prompt-${this.turns + 1}`, 'session/prompt', base)
    const wire = rpc(`cursor-prompt-${this.turns + 1}`, 'session/prompt', { ...base, prompt: [...base.prompt, ...images.map((image) => ({ type: 'image', mimeType: image.mime, data: Buffer.from(image.read()).toString('base64') }))] })
    return { wire, logged }
  }

  setOption(option: ChatOption, value: string): unknown[] {
    if (!this.ready()) throw new Rejection('chat-starting', 'Cursor 尚未就绪')
    if (this.turn) throw new Rejection('chat-busy', '请在回合结束后切换模式或模型')
    if (this.changing()) throw new Rejection('chat-option-changing', '请等待 Cursor 确认上一项配置变更')
    return [this.change(option, value, `cursor-config-${this.serial + 1}`)]
  }

  private changing(): boolean {
    return [...this.requests.values()].some((request) => ['session/set_config_option', 'session/set_mode', 'session/set_model'].includes(request.method))
  }

  optionResult(frame: unknown): { pending: boolean; error: string | null } {
    const id = Frame.safeParse(frame).data?.id
    return id === undefined ? { pending: false, error: null } : { pending: this.requests.has(keyOf(id)), error: this.optionErrors.get(keyOf(id)) ?? null }
  }

  private change(option: ChatOption, value: string, id: string): unknown {
    if (option === 'permissionMode' && this.options.planOnly && value !== 'plan') throw new Rejection('plan-only', '此阶段只能规划')
    if (option === 'effort') return this.changeEffort(value, id)
    const category = option === 'permissionMode' ? 'mode' : 'model'
    const config = this.config.find((entry) => entry.category === category)
    const wanted = option === 'permissionMode' ? nativeMode(value) : value
    if (!config || !valuesOf(config).some((entry) => entry.value === wanted)) throw new Rejection('chat-option-invalid', `Cursor 没有提供 ${option}: ${value}`)
    if (option === 'permissionMode' && !(value in CURSOR_MODES)) throw new Rejection('chat-option-invalid', `Cursor 不支持 ${value}`)
    if (this.modern.has(category)) return rpc(id, 'session/set_config_option', { sessionId: this.session, configId: config.id, value: wanted })
    return rpc(id, category === 'mode' ? 'session/set_mode' : 'session/set_model', { sessionId: this.session, ...(category === 'mode' ? { modeId: wanted } : { modelId: wanted }) })
  }

  // The session lists a level only after one is set. Until then the catalog's id is what the CLI accepts.
  private changeEffort(value: string, id: string): unknown {
    const modelId = this.config.find((entry) => entry.category === 'model')?.currentValue
    const live = this.config.find((entry) => entry.category === 'thought_level')
    const catalog = modelId ? this.thoughts.get(modelId) : undefined
    const configId = live?.id ?? catalog?.id
    const allowed = live ? valuesOf(live) : catalog?.values ?? []
    if (!configId || !allowed.some((entry) => entry.value === value)) throw new Rejection('chat-option-invalid', `Cursor 没有提供 effort: ${value}`)
    return rpc(id, 'session/set_config_option', { sessionId: this.session, configId, value })
  }

  private modelChange(request: Request): boolean {
    if (request.method === 'session/set_model') return true
    if (request.method !== 'session/set_config_option') return false
    const configId = z.looseObject({ configId: z.string().optional() }).safeParse(request.params).data?.configId
    return configId !== undefined && configId === this.config.find((entry) => entry.category === 'model')?.id
  }

  respond(requestId: string, answer: ChatAnswer): unknown[] {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Rejection('chat-request-gone', '这个请求已结束')
    if (pending.kind === 'permission') {
      const selected = pending.options?.find((option) => option.optionId === answer.choice)
      if (answer.choice && !selected) throw new Rejection('chat-option-invalid', 'Cursor 未提供这个审批选项')
      if (!selected && answer.decision !== 'deny') throw new Rejection('chat-option-invalid', '请选择 Cursor 提供的具体审批选项')
      return [result(pending.rawId, { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } })]
    }
    if (pending.kind === 'question') {
      const answers = Object.entries(answer.answers ?? {}).map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds }))
      return [result(pending.rawId, { outcome: answer.decision === 'deny' ? { outcome: 'cancelled' } : { outcome: 'answered', answers } })]
    }
    if (answer.saved) return this.cancelFrames()
    if (answer.decision === 'deny') return [result(pending.rawId, { outcome: { outcome: 'rejected' } })]
    if (this.options.planOnly) throw new Rejection('plan-only', '此阶段只能规划，请先保存计划')
    if (answer.mode && answer.mode !== 'ask') throw new Rejection('chat-option-invalid', 'Cursor 的计划只能在 Agent 模式执行')
    return [this.change('permissionMode', 'ask', `cursor-plan-mode-${encodeURIComponent(requestId)}`)]
  }

  interrupt(): unknown[] {
    if (!this.turn) throw new Rejection('chat-idle', '没有正在执行的回合')
    return this.cancelFrames()
  }

  private cancelFrames(): unknown[] {
    return [...[...this.pending.values()].map((pending) => result(pending.rawId, { outcome: { outcome: 'cancelled' } })), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.session } }]
  }

  logged(frame: unknown): unknown | null {
    const parsed = Frame.safeParse(frame)
    if (!parsed.success) return null
    const id = parsed.data.id
    const kept = id === undefined ? this.kept.get(JSON.stringify(frame)) : undefined
    this.kept.delete(JSON.stringify(frame))
    // ACP has no final full-text message: every delta is needed for recovery.
    return stripImageBytes(kept ?? frame)
  }

  private sent(frame: Frame, at: number, ref: string | undefined, images: readonly ChatImage[]): void {
    if (frame.method) {
      if (frame.id !== undefined) {
        this.requests.set(keyOf(frame.id), { method: frame.method, params: frame.params })
        this.serial++
      }
      if (frame.method === 'initialize') this.initSent = true
      else if (frame.method === 'authenticate') this.authSent = true
      else if (frame.method === 'cursor/list_available_models') this.modelsSent = true
      else if (frame.method === 'session/new' || frame.method === 'session/load') this.sessionSent = true
      else if (frame.method === 'session/cancel') { this.stopping = true; this.execution = null }
      else if (frame.method === 'session/prompt' && frame.id !== undefined) {
        const prompt = Prompt.safeParse(frame.params)
        if (!prompt.success) return
        const text = prompt.data.prompt.map((part) => part.text ?? '').join('')
        const eventRef = ref ?? `cursor:${++this.turns}`
        if (ref) this.turns++
        this.queue.sent(ref)
        if (ref === this.execution?.ref) this.execution = null
        this.stopping = false
        this.turn = { id: keyOf(frame.id), ref: eventRef, began: at, text: '', block: null, blocks: 0 }
        this.items.put({ id: `u:${eventRef}`, kind: 'user', text, images: [...images] }, at)
        this.messages.push({ role: 'user', text: messageText(text, images), eventKey: `chat:${eventRef}:user`, complete: false })
      }
      return
    }
    if (frame.id === undefined) return
    const id = keyOf(frame.id)
    this.owed.delete(id)
    const pending = this.pending.get(id)
    if (!pending) return
    const outcome = PermissionOutcome.safeParse(frame.result).data?.outcome
    const item = this.items.get(pending.itemId)
    if (item?.kind === 'approval') {
      const choice = pending.options?.find((option) => option.optionId === outcome?.optionId)
      const resolution = outcome?.outcome === 'accepted' || choice?.kind === 'allow_once' ? 'allowed' : choice?.kind === 'allow_always' ? 'allowedForSession' : outcome?.outcome === 'cancelled' ? 'cancelled' : 'denied'
      this.items.put({ ...item, resolution, chosen: outcome?.optionId ?? null, ...(outcome?.outcome === 'accepted' ? { mode: 'ask' as const } : {}) }, at)
      // CreatePlan acceptance creates an artifact and ends the planning turn. Execution needs
      // its own prompt; deriving it from the logged acceptance also survives a core restart.
      if (pending.kind === 'plan' && outcome?.outcome === 'accepted') this.execution = { text: '已确认上述计划，请在 Agent 模式按计划开始执行。先检查哪些步骤已经完成，避免重复操作。', images: [], ref: `cursor-plan:${this.stageId}:${id}` }
    } else if (item?.kind === 'question') {
      const answered = z.looseObject({ outcome: z.looseObject({ answers: z.array(z.looseObject({ questionId: z.string(), selectedOptionIds: z.array(z.string()) })) }) }).safeParse(frame.result)
      const answers = answered.success ? Object.fromEntries(answered.data.outcome.answers.map((answer) => [answer.questionId, answer.selectedOptionIds])) : null
      this.items.put({ ...item, answers, resolution: answers ? 'answered' : 'cancelled' }, at)
    }
    this.pending.delete(id)
  }

  private receive(frame: Frame, at: number): void {
    if (frame.method && frame.id !== undefined) { this.reverse(frame, at); return }
    if (frame.method === 'session/update') {
      const update = z.looseObject({ sessionId: z.string(), update: Update }).safeParse(frame.params)
      if (!update.success || (this.session && update.data.sessionId !== this.session)) return
      this.update(update.data.update, frame, at)
      return
    }
    if (frame.id === undefined) return
    const id = keyOf(frame.id)
    const request = this.requests.get(id)
    if (!request) return
    this.requests.delete(id)
    this.initial.delete(id)
    if (request.method === 'cursor/list_available_models') {
      this.modelsRead = true
      const listed = ModelCatalog.safeParse(frame.result)
      if (listed.success) this.readModels(listed.data.models)
      if (this.catalogOnly) this.state.set({ models: this.models })
      else if (this.setup) {
        this.nextInitial(at)
        this.publishConfig()
      }
      return
    }
    if (frame.error) {
      if (['session/set_config_option', 'session/set_mode', 'session/set_model'].includes(request.method)) this.optionErrors.set(id, frame.error.message)
      if (request.method === 'session/prompt') this.finish(this.stopping ? 'interrupted' : 'failed', frame.error.message, at)
      else if (!this.setup || String(frame.id).startsWith('cursor-initial-') || request.method === 'session/new' || request.method === 'session/load') this.startError = `${request.method}: ${frame.error.message}`
      else this.items.notice('error', frame.error.message, at)
      return
    }
    if (request.method === 'initialize') {
      const init = Initialized.safeParse(frame.result)
      if (!init.success) { this.startError = 'Cursor ACP 协议版本不兼容，请升级 CLI'; return }
      this.initialized = true
      this.load = init.data.agentCapabilities?.loadSession ?? false
      this.images = init.data.agentCapabilities?.promptCapabilities?.image ?? false
      this.directories = init.data.agentCapabilities?.sessionCapabilities?.additionalDirectories ?? false
      const auth = init.data.authMethods ?? []
      this.auth = auth.some((method) => method.id === 'cursor_login')
      if (auth.length && !this.auth) this.startError = 'Cursor 没有提供 cursor_login 认证方式，请在终端登录后重试'
    } else if (request.method === 'authenticate') this.authenticated = true
    else if (request.method === 'session/new' || request.method === 'session/load') {
      const opened = Opened.safeParse(frame.result ?? {})
      if (!opened.success) { this.startError = 'Cursor 返回了无效的会话信息'; return }
      this.session = opened.data.sessionId ?? this.options.resume
      if (!this.session) { this.startError = 'Cursor 没有返回会话 ID'; return }
      this.catalog(opened.data)
      this.setup = true
      const preferred = { ...this.options.preferred, ...(this.options.planOnly ? { permissionMode: 'plan' } : {}) }
      this.initialChoices = (['permissionMode', 'model', 'effort'] as const).flatMap((option) => preferred[option] ? [{ option, value: preferred[option] }] : [])
      // A log from before the catalog came second has it already.
      if (this.modelsRead) this.nextInitial(at)
    } else if (request.method === 'session/prompt') {
      const stop = z.looseObject({ stopReason: z.string().optional() }).safeParse(frame.result).data?.stopReason
      // Some CLI releases report provider failures as a text chunk followed by end_turn.
      const providerError = /^\s*Error: (?:RetriableError|ConnectError): \[[a-z_]+\][^\n]*\s*$/.test(this.turn?.text ?? '') ? this.turn?.text.trim() ?? null : null
      const error = stop === 'refusal' ? 'Cursor 拒绝了请求' : providerError
      this.finish(this.stopping || stop === 'cancelled' ? 'interrupted' : error ? 'failed' : 'completed', error, at)
    } else {
      const parsed = Configs.safeParse(frame.result)
      if (parsed.data?.configOptions) this.catalog(parsed.data, this.modelChange(request))
      else this.acknowledgeConfig(request)
      if (String(frame.id).startsWith('cursor-plan-mode-')) {
        const planId = decodeURIComponent(String(frame.id).slice('cursor-plan-mode-'.length))
        const pending = this.pending.get(planId)
        if (pending?.kind === 'plan' && this.state.current.permissionMode === 'ask') this.owed.set(planId, result(pending.rawId, { outcome: { outcome: 'accepted' } }))
      }
      if (String(frame.id).startsWith('cursor-initial-')) this.nextInitial(at)
    }
  }

  private nextInitial(at: number): void {
    while (this.initialChoices.length) {
      const choice = this.initialChoices.shift()
      if (!choice) return
      const { option, value } = choice
      // A resumed session keeps what it last ran with; setting it again costs a round trip.
      if (this.current(option) === (option === 'permissionMode' ? nativeMode(value) : value)) continue
      try {
        const requestId = `cursor-initial-${option}`
        this.initial.set(keyOf(requestId), this.change(option, value, requestId))
        return
      } catch (error) {
        if (option === 'permissionMode') this.startError = error instanceof Error ? error.message : 'Cursor 不支持所选模式'
        else this.items.notice('warning', `Cursor 未采用保存的 ${option}: ${value}`, at)
      }
    }
  }

  private current(option: ChatOption): string | null {
    const category = option === 'permissionMode' ? 'mode' : option === 'model' ? 'model' : 'thought_level'
    return this.config.find((entry) => entry.category === category)?.currentValue ?? null
  }

  private readModels(models: { value: string; name: string; configOptions: Config[] }[]): void {
    this.thoughts.clear()
    this.models = models.map((model) => {
      const thought = model.configOptions.find((config) => config.category === 'thought_level')
      const values = thought ? valuesOf(thought) : []
      if (thought && values.length) this.thoughts.set(model.value, { id: thought.id, name: thought.name, values })
      return { id: model.value, label: model.name, description: null, efforts: values.map((entry) => entry.value), isDefault: false }
    })
  }

  // A model switch answers with the whole config. A level the new model lacks is left out, and the
  // previous model's level must not stay selected. A one-option update is not that answer.
  private catalog(opened: z.infer<typeof Opened>, dropThought = false): void {
    const config = opened.configOptions ?? []
    if (dropThought && !config.some((entry) => entry.category === 'thought_level')) {
      this.config = this.config.filter((entry) => entry.category !== 'thought_level')
    }
    this.modern = new Set([...this.modern, ...config.flatMap((entry) => entry.category ? [entry.category] : [])])
    const modes = opened.modes
    const models = opened.models
    const legacy: Config[] = [
      ...(modes ? [{ id: 'mode', name: 'Mode', category: 'mode', currentValue: modes.currentModeId, options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) }] : []),
      ...(models ? [{ id: 'model', name: 'Model', category: 'model', currentValue: models.currentModelId, options: models.availableModels.map((model) => ({ value: model.modelId, name: model.name, description: model.description })) }] : [])
    ]
    const next = [...config, ...legacy.filter((entry) => !config.some((one) => one.category === entry.category))]
    this.config = [...this.config.filter((entry) => !next.some((one) => one.id === entry.id || one.category === entry.category)), ...next]
    this.publishConfig()
  }

  // An ack that only echoes the request still has to show the level just chosen.
  private acknowledgeConfig(request: Request): void {
    const value = z.looseObject({ configId: z.string().optional(), value: z.string().optional(), modeId: z.string().optional(), modelId: z.string().optional() }).safeParse(request.params).data
    const category = request.method === 'session/set_mode' ? 'mode' : request.method === 'session/set_model' ? 'model' : null
    const nextValue = value?.value ?? value?.modeId ?? value?.modelId
    const dropping = this.modelChange(request)
    let config = this.config.map((entry) => entry.id === value?.configId || (category && entry.category === category) ? { ...entry, currentValue: nextValue ?? entry.currentValue } : entry)
    if (dropping) config = config.filter((entry) => entry.category !== 'thought_level')
    const configId = value?.configId
    if (configId && nextValue && !config.some((entry) => entry.id === configId)) {
      const thought = this.thoughts.get(config.find((entry) => entry.category === 'model')?.currentValue ?? '')
      if (thought?.id === configId) {
        config = [...config, { id: thought.id, name: thought.name, category: 'thought_level', currentValue: nextValue, options: thought.values }]
        this.modern.add('thought_level')
      }
    }
    this.config = config
    this.publishConfig()
  }

  private publishConfig(): void {
    const mode = this.config.find((entry) => entry.category === 'mode')
    const model = this.config.find((entry) => entry.category === 'model')
    const effort = this.config.find((entry) => entry.category === 'thought_level')
    this.state.set({
      permissionMode: mode ? kandoMode(mode.currentValue) : null,
      permissionModes: mode ? valuesOf(mode).flatMap((entry) => { const mapped = kandoMode(entry.value); return mapped && (!this.options.planOnly || mapped === 'plan') ? [mapped] : [] }) : [],
      model: model?.currentValue ?? null,
      models: model ? valuesOf(model).map((entry) => ({ id: entry.value, label: entry.name, description: entry.description ?? null, efforts: this.models.find((one) => one.id === entry.value)?.efforts ?? (entry.value === model.currentValue && effort ? valuesOf(effort).map((one) => one.value) : []), isDefault: entry.value === model.currentValue })) : [],
      effort: effort?.currentValue ?? null
    })
    if (this.options.planOnly && mode && mode.currentValue !== 'plan' && this.setup && !this.initial.size && !this.initialChoices.length) this.startError = 'Cursor 离开了仅规划模式'
  }

  private update(update: z.infer<typeof Update>, frame: Frame, at: number): void {
    if (update.sessionUpdate === 'config_option_update' && update.configOptions) { this.catalog({ configOptions: update.configOptions }); return }
    if (update.sessionUpdate === 'current_mode_update' && update.currentModeId) {
      this.config = this.config.map((entry) => entry.category === 'mode' ? { ...entry, currentValue: update.currentModeId ?? entry.currentValue } : entry)
      this.publishConfig(); return
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.state.set({ commands: (update.availableCommands ?? []).map((command) => ({ name: command.name, description: command.description, argumentHint: command.input?.hint ?? null })) }); return
    }
    // session/load can replay the entire provider history before its response.
    if (!this.turn) return
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const text = Content.safeParse(update.content).data?.text ?? ''
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'reasoning'
      const previous = this.turn.block ? this.items.get(this.turn.block) : undefined
      if (!previous || previous.kind !== kind) {
        if (previous?.kind === 'assistant' || previous?.kind === 'reasoning') this.items.put({ ...previous, streaming: false }, at)
        const id = `${kind}:${this.turn.ref}:${++this.turn.blocks}`
        this.items.put({ id, kind, text, streaming: true }, at)
        this.turn.block = id
      } else this.items.append(previous.id, text)
      if (kind === 'assistant') this.turn.text += text
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') this.tool(update, frame, at)
    else if (update.sessionUpdate === 'plan') this.state.setTodos((update.entries ?? []).map((entry) => ({ content: entry.content, status: entry.status === 'completed' ? 'completed' : entry.status === 'in_progress' ? 'in_progress' : 'pending', activeForm: null })), this.turn.ref, at)
  }

  private tool(update: z.infer<typeof Update>, frame: Frame | null, at: number): void {
    if (!update.toolCallId) return
    const block = this.turn?.block ? this.items.get(this.turn.block) : null
    if (block?.kind === 'assistant' || block?.kind === 'reasoning') this.items.put({ ...block, streaming: false }, at)
    if (this.turn) this.turn.block = null
    const id = `tool:${update.toolCallId}`
    const previous = this.items.get(id)
    const old = previous?.kind === 'tool' ? previous : null
    const content = z.array(z.looseObject({ type: z.string(), content: z.unknown().optional(), path: z.string().optional(), oldText: z.string().nullish(), newText: z.string().optional() })).safeParse(update.content).data ?? []
    const blocks = content.flatMap((entry) => entry.type === 'content' ? [entry.content] : [])
    const images = this.options.keepImage ? keepImageBlocks(blocks, this.options.keepImage) : []
    if (images.length && frame) {
      const marked = markKeptImages(blocks, images)
      let index = 0
      const params = z.looseObject({ sessionId: z.string(), update: Update }).parse(frame.params)
      this.kept.set(JSON.stringify(frame), { ...frame, params: { ...params, update: { ...update, content: content.map((entry) => entry.type === 'content' ? { ...entry, content: marked[index++] } : entry) } } })
    }
    const output = takeImageMarkers(blocks.map((block) => Content.safeParse(block).data?.text ?? '').filter(Boolean).join('\n'))
    const raw = z.looseObject({ command: z.string().optional(), path: z.string().optional(), tool: z.string().optional(), toolName: z.string().optional(), providerIdentifier: z.string().optional(), args: z.unknown().optional() }).safeParse(update.rawInput).data
    const input = raw?.providerIdentifier && raw.toolName ? raw.args ?? update.rawInput : update.rawInput
    const name = raw?.providerIdentifier && raw.toolName ? `${raw.providerIdentifier}.${raw.toolName}` : raw?.toolName ?? raw?.tool ?? (update.kind === 'execute' ? 'commandExecution' : update.kind === 'edit' ? 'fileChange' : old?.name ?? update.kind ?? 'tool')
    const status = update.status === 'completed' ? 'done' : update.status === 'failed' ? 'failed' : old?.status ?? 'running'
    const exitCode = z.looseObject({ exitCode: z.number().int().nullish() }).safeParse(update.rawOutput).data?.exitCode ?? null
    this.items.put({
      id, kind: 'tool', name, title: raw?.command ?? raw?.path ?? update.title ?? old?.title ?? name,
      input: input === undefined ? old?.input ?? null : clip(JSON.stringify(input)), status,
      output: output.text ? clip(output.text) : update.rawOutput !== undefined ? clip(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) : old?.output ?? null,
      diffs: content.some((entry) => entry.type === 'diff') ? content.flatMap((entry) => entry.type === 'diff' && entry.path ? [{ path: entry.path, change: entry.oldText == null ? 'add' as const : 'update' as const, patch: clip(`--- ${entry.path}\n+++ ${entry.path}\n@@\n${(entry.oldText ?? '').split('\n').map((line) => `-${line}`).join('\n')}\n${(entry.newText ?? '').split('\n').map((line) => `+${line}`).join('\n')}`, 50_000) }] : []) : old?.diffs ?? [],
      ...(images.length || output.images.length ? { images: [...images, ...output.images] } : old?.images ? { images: old.images } : {}),
      ...(name === 'commandExecution' && (status === 'done' || status === 'failed') ? { execution: { status: status === 'done' ? 'completed' as const : 'failed' as const, exitCode } } : old?.execution ? { execution: old.execution } : {})
    }, at)
  }

  private reverse(frame: Frame, at: number): void {
    if (frame.id === undefined) return
    const id = keyOf(frame.id)
    if (this.pending.has(id) || this.owed.has(id)) return
    if (!['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(frame.method ?? '')) {
      this.owed.set(id, { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Kando does not handle this request' } })
      return
    }
    const scope = z.looseObject({ sessionId: z.string().optional() }).safeParse(frame.params).data?.sessionId
    if (!this.turn || (scope && scope !== this.session)) {
      this.owed.set(id, result(frame.id, { outcome: { outcome: 'cancelled' } })); return
    }
    if (frame.method === 'session/request_permission') {
      const request = Permission.safeParse(frame.params)
      if (request.success) {
        this.tool({ ...request.data.toolCall, sessionUpdate: 'tool_call' }, null, at)
        const itemId = `a:${id}`
        const tool = request.data.toolCall
        this.pending.set(id, { rawId: frame.id, itemId, kind: 'permission', options: request.data.options })
        const toolItem = tool.toolCallId ? this.items.get(`tool:${tool.toolCallId}`) : null
        this.items.put({ id: itemId, kind: 'approval', requestId: id, tool: toolItem?.kind === 'tool' ? toolItem.name : tool.kind ?? 'tool', title: tool.title ?? 'Cursor 工具调用', detail: tool.rawInput === undefined ? null : clip(JSON.stringify(tool.rawInput)), toolItemId: tool.toolCallId ? `tool:${tool.toolCallId}` : null, decisions: ['allow', 'deny'], choices: request.data.options.map((option) => ({ id: option.optionId, label: option.name, decision: option.kind === 'allow_once' ? 'allow' : option.kind === 'allow_always' ? 'allowForSession' : 'deny', grants: option.kind.endsWith('_always') ? [{ kind: 'other', values: [option.name], scope: 'agent', behavior: option.kind === 'reject_always' ? 'deny' : 'allow' }] : [] })), resolution: null }, at)
        return
      }
    } else if (frame.method === 'cursor/ask_question') {
      const request = Questions.safeParse(frame.params)
      if (request.success) {
        const itemId = `q:${id}`
        this.pending.set(id, { rawId: frame.id, itemId, kind: 'question' })
        this.items.put({ id: itemId, kind: 'question', requestId: id, questions: request.data.questions.map((question) => ({ id: question.id, header: request.data.title ?? '', question: question.prompt, options: question.options.map((option) => ({ ...option, description: null })), multiSelect: question.allowMultiple ?? false })), answers: null, resolution: null }, at)
        return
      }
    } else if (frame.method === 'cursor/create_plan') {
      const request = Plan.safeParse(frame.params)
      if (request.success) {
        const itemId = `a:${id}`
        this.pending.set(id, { rawId: frame.id, itemId, kind: 'plan' })
        this.items.put({ id: itemId, kind: 'approval', requestId: id, tool: 'cursor/create_plan', title: request.data.name ?? 'Cursor 计划', detail: request.data.plan, toolItemId: null, decisions: ['allow', 'deny'], resolution: null }, at)
        return
      }
    }
    this.owed.set(id, { jsonrpc: '2.0', id: frame.id, error: { code: ['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(frame.method ?? '') ? -32602 : -32601, message: 'Kando does not handle this request or its parameters' } })
  }

  private cancelPending(at: number): void {
    for (const pending of this.pending.values()) {
      const item = this.items.get(pending.itemId)
      if (item?.kind === 'approval' || item?.kind === 'question') this.items.put({ ...item, resolution: 'cancelled' }, at)
    }
    this.pending.clear()
  }

  private finish(state: ChatTurnState, error: string | null, at: number): void {
    const turn = this.turn
    if (!turn) return
    if (state !== 'completed') this.execution = null
    this.cancelPending(at)
    for (const item of this.items.list()) if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) this.items.put({ ...item, streaming: false }, at)
    this.items.settleTools(state === 'failed' ? 'failed' : 'interrupted', at)
    this.items.put({ id: `turn:${turn.ref}`, kind: 'turn', state, error, durationMs: at - turn.began }, at)
    if (turn.text) this.messages.push({ role: 'assistant', text: turn.text, eventKey: `chat:${turn.ref}:assistant`, complete: state === 'completed' })
    this.queue.turnEnded(state)
    this.state.endTurn()
    this.turn = null
  }
}
