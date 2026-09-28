import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { ChatRecord, ChatStageOptions } from './chat-driver'
import { parseChatRecord } from './chat-log'
import { CodexAppServer, unwrapShell } from './codex-app-server'

const OPTIONS: ChatStageOptions = { cwd: '/work/repo', extraDirs: [], resume: null }

// Recorded from codex-cli 0.156.1 (codex app-server, approvalPolicy untrusted so that it asks),
// then stripped of local paths.
function fixture(name: string): ChatRecord[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const record = line.trim() ? parseChatRecord(line) : null
      return record ? [record] : []
    })
}

function replay(records: readonly ChatRecord[], options = OPTIONS): CodexAppServer {
  const driver = new CodexAppServer('stage-1', options)
  records.forEach((record) => driver.apply(record))
  return driver
}

const ofKind = <K extends ChatItem['kind']>(items: ChatItem[], kind: K) =>
  items.filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)
const shown = (items: ChatItem[]) => items.map(({ revision: _revision, at: _at, ...item }) => item)

describe('CodexAppServer', () => {
  it('turns a recorded thread into messages, file and command cards, approvals and turn outcomes', () => {
    const driver = replay(fixture('codex-session.jsonl'))
    const items = driver.items.list()
    expect(driver.providerSessionId()).toBe('01a0e635-ad34-74f0-8ecb-2c49cb8429ad')
    expect(ofKind(items, 'user').map((item) => item.text)).toEqual([
      'Create a file named codex.txt containing the single word hi, then run `cat codex.txt`. Answer in one short sentence.',
      'Count from 1 to 400, one number per line, no other text.',
      'Say "done" and nothing else.'
    ])
    const tools = ofKind(items, 'tool')
    expect(tools.map((tool) => [tool.name, tool.title, tool.status])).toEqual([
      ['fileChange', '/work/repo/codex.txt', 'done'],
      ['commandExecution', 'cat codex.txt', 'done']
    ])
    expect(tools[0]?.diffs).toEqual([{ path: '/work/repo/codex.txt', change: 'add', patch: '+hi' }])
    expect(tools[1]?.output).toBe('hi\n')
    expect(ofKind(items, 'approval').map((approval) => [approval.tool, approval.resolution, approval.toolItemId])).toEqual([
      ['fileChange', 'allowed', tools[0]?.id],
      ['commandExecution', 'allowed', tools[1]?.id]
    ])
    expect(ofKind(items, 'turn').map((turn) => turn.state)).toEqual(['completed', 'interrupted', 'completed'])
    expect(ofKind(items, 'assistant').map((item) => item.streaming)).not.toContain(true)
    expect(driver.activity()).toBe('idle')
  })

  it('records the final answer of each turn, not its commentary', () => {
    const messages = replay(fixture('codex-session.jsonl')).takeMessages()
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text))
      .toEqual(['Created `codex.txt`; `cat codex.txt` outputs `hi`.', 'done'])
  })

  it('rebuilds the same items from its log, except text an interrupted turn only streamed', () => {
    const records = fixture('codex-session.jsonl')
    const live = replay(records)
    const logger = new CodexAppServer('stage-1', OPTIONS)
    const kept = records.flatMap((record): ChatRecord[] => {
      if (record.dir !== 'in') return [record]
      const frame = logger.logged(record.frame)
      return frame === null ? [] : [{ ...record, frame }]
    })
    expect(kept.length).toBeLessThan(records.length / 2)
    const streamedOnly = (item: ChatItem) => item.kind === 'assistant' && item.text.startsWith('1\n')
    expect(live.items.list().filter(streamedOnly)).toHaveLength(1)
    expect(shown(replay(kept).items.list())).toEqual(shown(live.items.list().filter((item) => !streamedOnly(item))))
  })

  it('resumes the thread a stage names', () => {
    const records = fixture('codex-resume.jsonl')
    const resume = '01a0e635-ad34-74f0-8ecb-2c49cb8429ad'
    const driver = replay(records, { ...OPTIONS, resume })
    expect(records.find((record) => record.dir === 'out' && JSON.stringify(record.frame).includes('thread/resume'))).toBeDefined()
    expect(driver.providerSessionId()).toBe(resume)
    expect(ofKind(driver.items.list(), 'assistant').at(-1)?.text).toBe('I created `codex.txt`.')
  })
})

describe('CodexAppServer state', () => {
  // gpt-6-luna at low effort, then medium effort with the untrusted policy (Kando's ask).
  const records = fixture('codex-options.jsonl')
  const stateOf = (driver: CodexAppServer) => ofKind(driver.items.list(), 'state')[0]

  it('reports the mode, model, effort and context the thread runs with', () => {
    const state = stateOf(replay(records))
    expect(state).toMatchObject({ permissionMode: 'ask', model: 'gpt-6-luna', effort: 'medium', permissionModes: ['ask', 'acceptEdits', 'plan', 'readOnly'] })
    expect(state?.models.find((model) => model.id === 'gpt-6-sol')).toMatchObject({ label: 'GPT-6-Sol', isDefault: true })
    expect(state?.models.find((model) => model.id === 'gpt-6-luna')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(state?.context).toEqual({ used: 22_525, window: 258_400 })
  })

  it('follows what each turn changed', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    const seen: string[] = []
    for (const record of records) {
      driver.apply(record)
      const state = stateOf(driver)
      const now = `${state?.permissionMode}/${state?.effort}`
      if (state && seen.at(-1) !== now) seen.push(now)
    }
    expect(seen).toEqual(['null/null', 'acceptEdits/medium', 'acceptEdits/low', 'ask/medium'])
  })

  it('turns a plan update into the turn\'s checklist', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    driver.apply({ dir: 'out', at: 1, frame: { id: 'kando-turn-1', method: 'turn/start', params: { input: [{ type: 'text', text: 'go' }] } }, ref: 'ref-1' })
    driver.apply({ dir: 'in', at: 2, frame: { method: 'turn/plan/updated', params: { plan: [{ step: 'Write the parser', status: 'completed' }, { step: 'Test it', status: 'inProgress' }] } } })
    const todos = [
      { content: 'Write the parser', status: 'completed', activeForm: null },
      { content: 'Test it', status: 'in_progress', activeForm: null }
    ]
    expect(stateOf(driver)?.todos).toEqual(todos)
    expect(driver.items.get('todos:ref-1')).toMatchObject({ kind: 'todos', todos })
  })

  it('rebuilds the same state from what it logs', () => {
    const logger = new CodexAppServer('stage-1', OPTIONS)
    const kept = records.flatMap((record): ChatRecord[] => {
      if (record.dir !== 'in') return [record]
      const frame = logger.logged(record.frame)
      return frame === null ? [] : [{ ...record, frame }]
    })
    expect(shown([stateOf(replay(kept))!])).toEqual(shown([stateOf(replay(records))!]))
  })
})

describe('CodexAppServer options', () => {
  const at = 3
  const live = (options = OPTIONS) => replay(fixture('codex-options.jsonl').filter((record) => record.dir !== 'exit'), options)
  const stateOf = (driver: CodexAppServer) => ofKind(driver.items.list(), 'state')[0]

  it('shows a choice at once and sends it with the next turn', () => {
    const driver = live()
    expect(driver.setOption('permissionMode', 'readOnly')).toEqual([])
    driver.apply({ dir: 'option', at, option: 'permissionMode', value: 'readOnly' })
    driver.apply({ dir: 'option', at, option: 'model', value: 'gpt-6-sol' })
    driver.apply({ dir: 'option', at, option: 'effort', value: 'ultra' })
    expect(stateOf(driver)).toMatchObject({ permissionMode: 'readOnly', model: 'gpt-6-sol', effort: 'ultra' })
    expect(driver.send('go')).toMatchObject({
      params: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, model: 'gpt-6-sol', effort: 'ultra' }
    })
  })

  it('refuses what the catalog does not list, and bypass unless the user allows it', () => {
    const driver = live()
    expect(() => driver.setOption('model', 'sonnet')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    expect(() => driver.setOption('effort', 'ultra')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    expect(() => driver.setOption('permissionMode', 'bypass')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    const allowed = live({ ...OPTIONS, allowBypass: true })
    allowed.apply({ dir: 'option', at, option: 'permissionMode', value: 'bypass' })
    expect(allowed.send('go')).toMatchObject({ params: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } })
  })

  it('opens a thread with what the conversation chose last time', () => {
    const driver = new CodexAppServer('stage-1', { ...OPTIONS, preferred: { permissionMode: 'ask', model: 'gpt-6-luna' } })
    driver.apply({ dir: 'out', at, frame: driver.due()[0] })
    driver.apply({ dir: 'in', at, frame: { id: 'kando-init', result: {} } })
    expect(driver.due()[1]).toMatchObject({ method: 'thread/start', params: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', model: 'gpt-6-luna' } })
  })
})

describe('CodexAppServer commands', () => {
  const at = 1
  const handshake = (driver: CodexAppServer, threadId = 'thread-1', thread: Record<string, unknown> = {}) => {
    driver.due().forEach((frame) => driver.apply({ dir: 'out', at, frame }))
    driver.apply({ dir: 'in', at, frame: { id: 'kando-init', result: {} } })
    const [initialized, open, models, config] = driver.due()
    expect(models).toEqual({ id: 'kando-models', method: 'model/list', params: {} })
    expect(config).toEqual({ id: 'kando-config', method: 'config/read', params: { cwd: '/work/repo' } })
    for (const frame of [initialized, open, models, config]) driver.apply({ dir: 'out', at, frame })
    driver.apply({ dir: 'in', at, frame: { id: 'kando-thread', result: { thread: { id: threadId }, ...thread } } })
    return { initialized, open }
  }

  // A thread in plan mode whose first turn ended with a plan.
  const planned = () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver, 'thread-1', { model: 'gpt-x', reasoningEffort: 'low' })
    expect(driver.setOption('permissionMode', 'plan')).toEqual([])
    driver.apply({ dir: 'option', at, option: 'permissionMode', value: 'plan' })
    const turn = driver.send('Plan a README')
    driver.apply({ dir: 'out', at, frame: turn, ref: 'ref-1' })
    const plan = (id: string, text: string) => {
      driver.apply({ dir: 'in', at, frame: { method: 'item/completed', params: { item: { type: 'plan', id, text } } } })
      driver.apply({ dir: 'in', at, frame: { method: 'turn/completed', params: { turn: { id: `turn-${id}`, status: 'completed', error: null } } } })
    }
    plan('p1', '1. Write README.md')
    return { driver, turn, plan }
  }
  const modeOf = (driver: CodexAppServer) => ofKind(driver.items.list(), 'state')[0]?.permissionMode

  it('takes the model config.toml names as the default, keeping only that of the config', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'in', at, frame: { id: 'kando-models', result: { data: [{ id: 'gpt-x', isDefault: true }, { id: 'gpt-y', isDefault: false }] } } })
    const reply = { id: 'kando-config', result: { config: { model: 'gpt-y', mcp_servers: { secret: { env: { TOKEN: 'x' } } } } } }
    expect(driver.logged(reply)).toEqual({ id: 'kando-config', result: { config: { model: 'gpt-y' } } })
    driver.apply({ dir: 'in', at, frame: reply })
    expect(ofKind(driver.items.list(), 'state')[0]?.models.map((model) => [model.id, model.isDefault])).toEqual([['gpt-x', false], ['gpt-y', true]])
  })

  it('plans in Codex plan mode, and carries the plan out in the mode picked', () => {
    const { driver, turn } = planned()
    expect(turn).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly' },
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-x', reasoning_effort: 'low', developer_instructions: null } }
      }
    })
    expect(driver.items.get('a:plan:p1')).toMatchObject({ kind: 'approval', tool: 'plan', detail: '1. Write README.md', resolution: null })
    // The turn is over, yet the plan waits on the user.
    expect(driver.activity()).toBe('awaiting')
    const [execute] = driver.respond('plan:p1', { decision: 'allowForSession' })
    expect(execute).toMatchObject({
      method: 'turn/start',
      params: { input: [{ text: '按这个计划开始执行。' }], approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default' } }
    })
    driver.apply({ dir: 'out', at, frame: execute, ref: 'ref-2' })
    expect(driver.items.get('a:plan:p1')).toMatchObject({ resolution: 'allowedForSession' })
    expect(modeOf(driver)).toBe('acceptEdits')
    expect(driver.activity()).toBe('running')
    driver.apply({ dir: 'in', at, frame: { method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed', error: null } } } })
    // Out of plan mode, later turns say nothing of it.
    expect(driver.send('next')).not.toHaveProperty('params.collaborationMode')
  })

  it('sends a plan back with a note, takes a message as more planning, and lets it go on exit', () => {
    const { driver, plan } = planned()
    const [again] = driver.respond('plan:p1', { decision: 'deny', message: 'Add a usage section' })
    expect(again).toMatchObject({ params: { input: [{ text: '继续规划：Add a usage section' }], collaborationMode: { mode: 'plan' } } })
    driver.apply({ dir: 'out', at, frame: again, ref: 'ref-2' })
    expect(driver.items.get('a:plan:p1')).toMatchObject({ resolution: 'denied' })
    expect(modeOf(driver)).toBe('plan')
    plan('p2', '1. Write README.md\n2. Add usage')
    const typed = driver.send('Shorter, please')
    expect(typed).toMatchObject({ params: { collaborationMode: { mode: 'plan' } } })
    driver.apply({ dir: 'out', at, frame: typed, ref: 'ref-3' })
    expect(driver.items.get('a:plan:p2')).toMatchObject({ resolution: 'denied' })
    plan('p3', '1. README with usage')
    driver.apply({ dir: 'exit', at, code: 0, stderr: '' })
    expect(driver.items.get('a:plan:p3')).toMatchObject({ resolution: 'cancelled' })
    expect(driver.activity()).toBe('idle')
  })

  it('shakes hands, then opens a thread with its policy stated outright', () => {
    const driver = new CodexAppServer('stage-1', { ...OPTIONS, extraDirs: ['/work/web'] })
    expect(driver.due()).toEqual([expect.objectContaining({ id: 'kando-init', method: 'initialize' })])
    const { initialized, open } = handshake(driver)
    expect(initialized).toEqual({ method: 'initialized' })
    expect(open).toEqual({ id: 'kando-thread', method: 'thread/start', params: { cwd: '/work/repo', approvalPolicy: 'on-request', sandbox: 'workspace-write' } })
    expect(driver.ready()).toBe(true)
    expect(driver.due()).toEqual([])
    expect(driver.send('go')).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thread-1', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/web'] } }
    })
  })

  it('denies with decline where Codex offers it and with cancel where it does not', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: { id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'exec-1' } } })
    driver.apply({ dir: 'in', at, frame: { id: 1, method: 'item/commandExecution/requestApproval', params: { itemId: 'exec-2', command: "/bin/zsh -lc 'rm -rf build'", availableDecisions: ['accept', 'cancel'] } } })
    expect(driver.activity()).toBe('awaiting')
    expect(driver.items.get('a:1')).toMatchObject({ title: 'rm -rf build', decisions: ['allow', 'deny'] })
    expect(driver.respond('0', { decision: 'deny' })).toEqual([{ id: 0, result: { decision: 'decline' } }])
    expect(driver.respond('1', { decision: 'deny' })).toEqual([{ id: 1, result: { decision: 'cancel' } }])
    driver.apply({ dir: 'out', at, frame: driver.respond('0', { decision: 'allowForSession' })[0] })
    expect(driver.items.get('a:0')).toMatchObject({ resolution: 'allowedForSession' })
  })

  it('interrupts the running turn after cancelling what waits on the user', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    expect(() => driver.interrupt()).toThrow(expect.objectContaining({ reason: 'chat-busy' }))
    driver.apply({ dir: 'in', at, frame: { id: 'kando-turn-1', result: { turn: { id: 'turn-9' } } } })
    driver.apply({ dir: 'in', at, frame: { id: 4, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'A' }] }] } } })
    expect(driver.interrupt()).toEqual([
      { id: 4, result: { answers: {} } },
      { id: 'kando-interrupt-1', method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-9' } }
    ])
  })

  it('marks calls the user stopped as interrupted rather than failed', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: { id: 'kando-turn-1', result: { turn: { id: 'turn-9' } } } })
    const command = (id: string, status: string) => ({ type: 'commandExecution', id, command: 'sleep 5', status, exitCode: status === 'inProgress' ? null : 1 })
    driver.apply({ dir: 'in', at, frame: { method: 'item/completed', params: { item: command('exec-1', 'failed') } } })
    driver.apply({ dir: 'in', at, frame: { method: 'item/started', params: { item: command('exec-2', 'inProgress') } } })
    driver.apply({ dir: 'in', at, frame: { method: 'item/started', params: { item: command('exec-3', 'inProgress') } } })
    driver.interrupt().forEach((frame) => driver.apply({ dir: 'out', at, frame }))
    driver.apply({ dir: 'in', at, frame: { method: 'item/completed', params: { item: command('exec-2', 'failed') } } })
    driver.apply({ dir: 'in', at, frame: { method: 'turn/completed', params: { turn: { id: 'turn-9', status: 'interrupted', error: null } } } })
    expect(ofKind(driver.items.list(), 'tool').map((tool) => tool.status)).toEqual(['failed', 'interrupted', 'interrupted'])
  })

  it('answers a request it does not handle with an error, once', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'in', at, frame: { id: 7, method: 'mcpServer/elicitation/request', params: {} } })
    const [reply] = driver.due()
    expect(reply).toMatchObject({ id: 7, error: { code: -32601 } })
    driver.apply({ dir: 'out', at, frame: reply })
    expect(driver.due()).toEqual([])
  })

  it('says plainly when the installed Codex has no app-server', () => {
    const old = new CodexAppServer('stage-1', OPTIONS)
    old.due().forEach((frame) => old.apply({ dir: 'out', at, frame }))
    old.apply({ dir: 'exit', at, code: 2, stderr: "error: unrecognized subcommand 'app-server'" })
    expect(old.failure()).toContain('不支持聊天模式')
    expect(ofKind(old.items.list(), 'notice')[0]?.level).toBe('error')
  })

  it('reads the command inside the shell wrapper Codex adds', () => {
    expect(unwrapShell("/bin/zsh -lc 'cat codex.txt'")).toBe('cat codex.txt')
    expect(unwrapShell(`bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'")
    expect(unwrapShell('git status')).toBe('git status')
  })
})

describe('CodexAppServer plan mode, as recorded', () => {
  // Codex 0.156.1: a plan-mode turn that ended with a plan, then the turn that carried it out with
  // edits accepted, as Kando logged them.
  const records = fixture('codex-plan.jsonl')

  it('shows the plan as one approval, answered by the turn that carried it out', () => {
    const items = replay(records).items.list()
    const [plan] = ofKind(items, 'approval')
    expect(plan).toMatchObject({ tool: 'plan', title: '计划', resolution: 'allowedForSession' })
    expect(plan?.detail).toContain('codex-plan.txt')
    expect(ofKind(items, 'user').map((item) => item.text)).toEqual([expect.stringContaining('Plan adding a file codex-plan.txt'), '按这个计划开始执行。'])
    expect(ofKind(items, 'tool').map((tool) => [tool.name, tool.status])).toEqual([
      ['commandExecution', 'done'],
      ['fileChange', 'done'],
      ['commandExecution', 'done']
    ])
    expect(ofKind(items, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed'])
    expect(ofKind(items, 'state')[0]?.permissionMode).toBe('acceptEdits')
  })

  it('waits on the user between the plan and its answer', () => {
    const answer = records.findIndex((record, index) => index > 0 && record.dir === 'out' && JSON.stringify(record.frame).includes('按这个计划开始执行'))
    const driver = replay(records.slice(0, answer))
    expect(driver.activity()).toBe('awaiting')
    expect(ofKind(driver.items.list(), 'state')[0]?.permissionMode).toBe('plan')
    expect(ofKind(driver.items.list(), 'approval')[0]?.resolution).toBeNull()
  })
})
