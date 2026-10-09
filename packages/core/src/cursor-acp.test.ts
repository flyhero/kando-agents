import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ChatItem } from '@kando/protocol'
import { CursorAcp } from './cursor-acp'
import type { ChatRecord, ChatStageOptions } from './chat-driver'
import { parseChatRecord } from './chat-log'

const OPTIONS: ChatStageOptions = { cwd: '/work/repo', extraDirs: [], resume: null, mcp: { command: 'node', args: ['mcp.mjs', '--conversation', 'conversation'] } }
const modes = { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] }
const models = { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'model-1', name: 'Model One' }] }
const modeConfig = { id: 'native-mode', category: 'mode', name: 'Mode', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }] }
const Request = z.looseObject({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() })
const receive = (driver: CursorAcp, frame: unknown, at = 2) => driver.apply({ dir: 'in', at, frame })
const send = (driver: CursorAcp, frame: unknown, at = 1) => driver.apply({ dir: 'out', at, frame })
const modelsRead = (driver: CursorAcp) => { due(driver); receive(driver, { id: 'cursor-models', result: { models: [] } }) }
const due = (driver: CursorAcp) => { const frames = driver.due(); frames.forEach((frame) => send(driver, frame)); return frames }
const update = (driver: CursorAcp, content: unknown) => receive(driver, { method: 'session/update', params: { sessionId: 'session', update: content } })
const items = <K extends ChatItem['kind']>(driver: CursorAcp, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

function opened(options = OPTIONS, modern = false): CursorAcp {
  const driver = new CursorAcp('stage', options)
  due(driver)
  receive(driver, { id: 'cursor-init', result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } })
  modelsRead(driver); due(driver)
  receive(driver, { id: 'cursor-session', result: { sessionId: 'session', modes, models, ...(modern ? { configOptions: [modeConfig] } : {}) } })
  for (const frame of due(driver)) {
    const request = Request.parse(frame)
    const wanted = options.planOnly ? 'plan' : options.preferred?.permissionMode === 'readOnly' ? 'ask' : 'agent'
    receive(driver, { id: request.id, result: modern ? { configOptions: [{ ...modeConfig, currentValue: wanted }] } : {} })
  }
  return driver
}

function prompt(driver: CursorAcp): string {
  const message = driver.send('hello')
  send(driver, message.logged)
  return String(Request.parse(message.wire).id)
}

function permission(driver: CursorAcp, id: string | number = 9): void {
  receive(driver, { id, method: 'session/request_permission', params: { sessionId: 'session', toolCall: { toolCallId: 'call', title: 'Run test', kind: 'execute', rawInput: { command: 'pnpm test' } }, options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } })
}

describe('Cursor ACP', () => {
  it.each(['cursor-session.jsonl', 'cursor-resume-plan.jsonl'])('replays the real CLI recording %s without repeating provider history or losing tool identity', (file) => {
    const records = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8').trim().split('\n').map(parseChatRecord)
    expect(records.every(Boolean)).toBe(true)
    const driver = new CursorAcp('stage', { ...OPTIONS, ...(file.includes('resume') ? { resume: '00000002-0000-4000-8000-000000000000' } : {}) })
    records.forEach((record) => { if (record) driver.apply(record) })
    const turns = items(driver, 'turn')
    expect(turns.map((turn) => turn.state)).toEqual(file.includes('resume') ? ['completed', 'completed', 'completed'] : ['completed'])
    expect(driver.due()).toEqual([])
    expect(items(driver, 'approval').some((approval) => approval.resolution === 'allowed')).toBe(true)
    if (file.includes('resume')) {
      expect(items(driver, 'approval').find((approval) => approval.tool === 'cursor/create_plan')).toMatchObject({ resolution: 'allowed', mode: 'ask' })
      expect(items(driver, 'user').some((item) => item.text.includes('CURSOR_TERMINAL_OK'))).toBe(false)
    } else {
      expect(items(driver, 'tool').find((tool) => tool.name === 'kando.terminal_run')).toMatchObject({ status: 'done', input: '{"command":"printf CURSOR_TERMINAL_OK"}' })
    }
    for (const item of driver.items.list()) expect(ChatItem.safeParse(item).success).toBe(true)
  })
  it('reads parameterized model IDs and per-model efforts without creating a catalog session', () => {
    const driver = new CursorAcp('catalog', OPTIONS, true)
    due(driver); receive(driver, { id: 'cursor-init', result: { protocolVersion: 1 } })
    expect(due(driver)).toMatchObject([{ method: 'cursor/list_available_models' }])
    receive(driver, { id: 'cursor-models', result: { models: [{ value: 'base-model', name: 'Model', configOptions: [{ ...modeConfig, category: 'thought_level', options: [{ value: 'high', name: 'High' }] }] }] } })
    expect(items(driver, 'state')[0]?.models).toMatchObject([{ id: 'base-model', efforts: ['high'] }])
    expect(driver.due()).toEqual([])
    expect(driver.providerSessionId()).toBeNull()
  })

  it('waits for configuration acknowledgement, reports rejection, and prevents concurrent switches or prompts', () => {
    const driver = opened(OPTIONS, true)
    const [frame] = driver.setOption('permissionMode', 'plan')
    send(driver, frame)
    expect(driver.optionResult(frame).pending).toBe(true)
    expect(() => driver.setOption('permissionMode', 'ask')).toThrow()
    expect(() => driver.send('hello')).toThrow()
    receive(driver, { id: Request.parse(frame).id, error: { code: -32602, message: 'cannot switch' } })
    expect(driver.optionResult(frame)).toEqual({ pending: false, error: 'cannot switch' })
    expect(driver.activity()).toBe('idle')
  })

  it('marks a provider failure encoded as a text-only end_turn as failed', () => {
    const driver = opened(); const id = prompt(driver)
    update(driver, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nError: RetriableError: [resource_exhausted] Error' } })
    receive(driver, { id, result: { stopReason: 'end_turn' } })
    expect(items(driver, 'turn')[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('resource_exhausted') })
  })
  it('initializes without delegating filesystem or terminal ownership and binds the conversation MCP', () => {
    const driver = new CursorAcp('stage', OPTIONS)
    expect(due(driver)).toMatchObject([{ method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }])
    receive(driver, { id: 'cursor-init', result: { protocolVersion: 1 } })
    modelsRead(driver)
    expect(due(driver)).toMatchObject([{ method: 'session/new', params: { cwd: '/work/repo', mcpServers: [{ name: 'kando', command: 'node', args: OPTIONS.mcp?.args, env: [] }] } }])
  })

  it('authenticates using the advertised Cursor method and surfaces an authentication failure', () => {
    const driver = new CursorAcp('stage', OPTIONS)
    due(driver)
    receive(driver, { id: 'cursor-init', result: { protocolVersion: '1', authMethods: [{ id: 'cursor_login' }] } })
    expect(due(driver)).toMatchObject([{ method: 'authenticate', params: { methodId: 'cursor_login' } }])
    receive(driver, { id: 'cursor-auth', error: { code: -32000, message: 'Login required' } })
    expect(driver.failure()).toContain('Login required')
    expect(driver.ready()).toBe(false)
  })

  it('rejects incompatible protocol versions and unsupported authentication methods', () => {
    for (const response of [{ protocolVersion: 2 }, { protocolVersion: 1, authMethods: [{ id: 'other' }] }]) {
      const driver = new CursorAcp('stage', OPTIONS)
      due(driver); receive(driver, { id: 'cursor-init', result: response })
      expect(driver.failure()).not.toBeNull()
      expect(driver.due()).toEqual([])
    }
  })

  it('uses legacy mode/model methods, modern configuration takes precedence, and updates the live catalog', () => {
    const legacy = opened()
    expect(legacy.setOption('permissionMode', 'readOnly')).toMatchObject([{ method: 'session/set_mode', params: { modeId: 'ask' } }])
    expect(legacy.setOption('model', 'model-1')).toMatchObject([{ method: 'session/set_model', params: { modelId: 'model-1' } }])
    const driver = opened(OPTIONS, true)
    const [frame] = driver.setOption('permissionMode', 'plan')
    expect(frame).toMatchObject({ method: 'session/set_config_option', params: { configId: 'native-mode', value: 'plan' } })
    send(driver, frame)
    receive(driver, { id: Request.parse(frame).id, result: { configOptions: [{ ...modeConfig, currentValue: 'plan' }] } })
    expect(items(driver, 'state')[0]).toMatchObject({ permissionMode: 'plan', permissionModes: ['ask', 'plan', 'readOnly'] })
    expect(() => driver.setOption('permissionMode', 'bypass')).toThrow()
    expect(() => driver.setOption('effort', 'high')).toThrow()
  })

  it('keeps streamed text, thinking and tools in order and persists complete messages only once', () => {
    const driver = opened()
    const id = prompt(driver)
    update(driver, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    update(driver, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } })
    update(driver, { sessionUpdate: 'tool_call', toolCallId: 'search', kind: 'execute', title: 'search', rawInput: { command: 'rg missing' } })
    update(driver, { sessionUpdate: 'tool_call_update', toolCallId: 'search', status: 'completed', rawOutput: { exitCode: 1 }, content: [{ type: 'content', content: { type: 'text', text: 'no match' } }] })
    update(driver, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } })
    receive(driver, { id, result: { stopReason: 'end_turn' } })
    expect(items(driver, 'assistant').map((item) => item.text)).toEqual(['before', 'after'])
    expect(items(driver, 'tool')[0]).toMatchObject({ status: 'done', execution: { status: 'completed', exitCode: 1 } })
    expect(driver.activity()).toBe('idle')
    expect(driver.takeMessages().map((message) => [message.role, message.text, message.complete])).toEqual([['user', 'hello', false], ['assistant', 'beforeafter', true]])
    expect(driver.takeMessages()).toEqual([])
    for (const item of driver.items.list()) expect(ChatItem.safeParse(item).success).toBe(true)
  })

  it('preserves unknown exit codes and execution failures', () => {
    const driver = opened(); prompt(driver)
    update(driver, { sessionUpdate: 'tool_call', toolCallId: 'run', kind: 'execute', title: 'run', status: 'failed' })
    expect(items(driver, 'tool')[0]).toMatchObject({ status: 'failed', execution: { status: 'failed', exitCode: null } })
  })

  it('answers duplicate labels using the exact option ID and keeps number and string request IDs distinct', () => {
    const driver = opened(); prompt(driver)
    permission(driver, 9); permission(driver, '9')
    const approvals = items(driver, 'approval')
    expect(approvals).toHaveLength(2)
    const requestId = approvals[0]!.requestId
    expect(() => driver.respond(requestId, { decision: 'allow', choice: 'Allow' })).toThrow()
    const [answer] = driver.respond(requestId, { decision: 'allowForSession', choice: 'always' })
    expect(answer).toMatchObject({ id: 9, result: { outcome: { outcome: 'selected', optionId: 'always' } } })
    send(driver, answer)
    expect(items(driver, 'approval')[0]).toMatchObject({ chosen: 'always', resolution: 'allowedForSession', choices: [expect.anything(), expect.objectContaining({ grants: [expect.objectContaining({ scope: 'agent' })] }), expect.anything()] })
    expect(driver.activity()).toBe('awaiting')
  })

  it('streams while a question waits and returns stable question/option IDs', () => {
    const driver = opened(); prompt(driver)
    receive(driver, { id: 'question', method: 'cursor/ask_question', params: { toolCallId: 'ask', title: 'Choose', questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'first', label: 'Same' }, { id: 'second', label: 'Same' }], allowMultiple: true }] } })
    update(driver, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still streaming' } })
    const question = items(driver, 'question')[0]!
    expect(question.questions[0]?.options.map((option) => option.id)).toEqual(['first', 'second'])
    const [answer] = driver.respond(question.requestId, { decision: 'allow', answers: { q: ['second'] } })
    expect(answer).toMatchObject({ result: { outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['second'] }] } } })
    send(driver, answer)
    expect(items(driver, 'assistant')[0]?.text).toBe('still streaming')
    expect(driver.activity()).toBe('running')
  })

  it('waits for Agent mode acknowledgement before approving a plan', () => {
    const driver = opened(OPTIONS, true); prompt(driver)
    receive(driver, { id: 'plan', method: 'cursor/create_plan', params: { toolCallId: 'plan-call', plan: '# Plan' } })
    const plan = items(driver, 'approval')[0]!
    const frames = driver.respond(plan.requestId, { decision: 'allow', mode: 'ask' })
    expect(frames).toHaveLength(1)
    expect(Request.parse(frames[0]).method).toBe('session/set_config_option')
    send(driver, frames[0])
    expect(items(driver, 'approval')[0]?.resolution).toBeNull()
    receive(driver, { id: Request.parse(frames[0]).id, result: { configOptions: [modeConfig] } })
    expect(due(driver)).toMatchObject([{ id: 'plan', result: { outcome: { outcome: 'accepted' } } }])
    expect(items(driver, 'approval')[0]).toMatchObject({ resolution: 'allowed', mode: 'ask' })
    expect(driver.queuedToSend()).toBeNull()
    receive(driver, { id: 'cursor-prompt-1', result: { stopReason: 'end_turn' } })
    const execution = driver.queuedToSend()
    expect(execution?.text).toContain('按计划开始执行')
    if (!execution) throw new Error('no execution prompt')
    const outgoing = driver.send(execution.text)
    driver.apply({ dir: 'out', at: 3, ref: execution.ref, frame: outgoing.logged })
    expect(driver.queuedToSend()).toBeNull()
  })

  it('locks a planning stage, saves without accepting, and returns one response per request', () => {
    const driver = opened({ ...OPTIONS, planOnly: true }, true); prompt(driver)
    expect(items(driver, 'state')[0]?.permissionModes).toEqual(['plan'])
    expect(() => driver.setOption('permissionMode', 'ask')).toThrow()
    receive(driver, { id: 'plan', method: 'cursor/create_plan', params: { toolCallId: 'plan', plan: '# Plan' } })
    const request = items(driver, 'approval')[0]!.requestId
    expect(() => driver.respond(request, { decision: 'allow' })).toThrow()
    const frames = driver.respond(request, { decision: 'deny', saved: true })
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ id: 'plan', result: { outcome: { outcome: 'cancelled' } } })
    frames.forEach((frame) => send(driver, frame))
    receive(driver, { id: 'cursor-prompt-1', result: { stopReason: 'cancelled' } })
    expect(items(driver, 'turn')[0]?.state).toBe('interrupted')
  })

  it('does not carry out an accepted plan if the user interrupts before execution starts', () => {
    const driver = opened(OPTIONS, true); prompt(driver)
    receive(driver, { id: 'plan', method: 'cursor/create_plan', params: { toolCallId: 'plan', plan: '# Plan' } })
    const [switchMode] = driver.respond(items(driver, 'approval')[0]!.requestId, { decision: 'allow', mode: 'ask' })
    send(driver, switchMode)
    receive(driver, { id: Request.parse(switchMode).id, result: { configOptions: [modeConfig] } })
    due(driver)
    driver.interrupt().forEach((frame) => send(driver, frame))
    receive(driver, { id: 'cursor-prompt-1', result: { stopReason: 'cancelled' } })
    expect(driver.queuedToSend()).toBeNull()
  })

  it('does not start a new session after load failure, and filters replayed history while keeping configuration', () => {
    const driver = new CursorAcp('stage', { ...OPTIONS, resume: 'old' })
    due(driver); receive(driver, { id: 'cursor-init', result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    modelsRead(driver)
    expect(due(driver)).toMatchObject([{ method: 'session/load', params: { sessionId: 'old' } }])
    receive(driver, { method: 'session/update', params: { sessionId: 'old', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old text' } } } })
    receive(driver, { id: 'cursor-session', error: { code: -32602, message: 'Session old not found' } })
    expect(items(driver, 'assistant')).toHaveLength(0)
    expect(driver.failure()).toContain('not found')
    expect(driver.due()).toEqual([])
  })

  it('loads without a returned session ID and declares capability limits before sending', () => {
    const driver = new CursorAcp('stage', { ...OPTIONS, resume: 'old' })
    due(driver); receive(driver, { id: 'cursor-init', result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); modelsRead(driver); due(driver)
    receive(driver, { id: 'cursor-session', result: { modes, models } })
    expect(driver.providerSessionId()).toBe('old')
    expect(() => driver.send('image', [{ id: 'image', width: 1, height: 1, mime: 'image/png', path: '/image', read: () => new Uint8Array() }])).toThrow()
    const extra = new CursorAcp('stage', { ...OPTIONS, extraDirs: ['/other'] })
    due(extra); receive(extra, { id: 'cursor-init', result: { protocolVersion: 1 } })
    modelsRead(extra)
    expect(extra.due()).toEqual([])
    expect(extra.failure()).toContain('附加项目')
  })

  it('rebuilds a live stage without repeating requests, including all streamed deltas', () => {
    const records: ChatRecord[] = [
      { dir: 'out', at: 1, frame: { id: 'cursor-init', method: 'initialize' } },
      { dir: 'in', at: 2, frame: { id: 'cursor-init', result: { protocolVersion: 1 } } },
      { dir: 'out', at: 2, frame: { id: 'cursor-models', method: 'cursor/list_available_models' } },
      { dir: 'in', at: 2, frame: { id: 'cursor-models', result: { models: [] } } },
      { dir: 'out', at: 3, frame: { id: 'cursor-session', method: 'session/new' } },
      { dir: 'in', at: 4, frame: { id: 'cursor-session', result: { sessionId: 'session', modes, models } } },
      { dir: 'out', at: 5, ref: 'message', frame: { id: 'cursor-prompt-1', method: 'session/prompt', params: { sessionId: 'session', prompt: [{ type: 'text', text: 'hello' }] } } },
      { dir: 'in', at: 6, frame: { method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } } }
    ]
    const driver = new CursorAcp('stage', OPTIONS)
    records.forEach((record) => driver.apply(record))
    expect(driver.due()).toEqual([])
    expect(driver.activity()).toBe('running')
    const last = records.at(-1)
    if (last?.dir !== 'in') throw new Error('expected an incoming frame')
    expect(driver.logged(last.frame)).toEqual(last.frame)
    expect(items(driver, 'assistant')[0]?.text).toBe('partial')
    permission(driver)
    const stop = driver.interrupt(); stop.forEach((frame) => send(driver, frame))
    receive(driver, { id: 'cursor-prompt-1', result: { stopReason: 'cancelled' } })
    expect(driver.due()).toEqual([])
    expect(items(driver, 'approval')[0]?.resolution).toBe('cancelled')
    expect(items(driver, 'turn')[0]?.state).toBe('interrupted')
  })

  it('keeps the final structured error and rejects unsupported reverse requests without blocking output', () => {
    const driver = opened(); const id = prompt(driver)
    receive(driver, { id: 'unknown', method: 'fs/write_text_file', params: { path: '/work/file' } })
    expect(due(driver)).toMatchObject([{ id: 'unknown', error: { code: -32601 } }])
    receive(driver, { id, error: { code: -32000, message: 'The actual provider error' } })
    driver.apply({ dir: 'exit', at: 5, code: 1, stderr: 'generic exit' })
    expect(items(driver, 'turn')[0]?.error).toBe('The actual provider error')
  })
})
