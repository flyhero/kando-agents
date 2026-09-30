import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { ChatRecord, ChatStageOptions } from './chat-driver'
import { parseChatRecord } from './chat-log'
import { CodexAppServer, commandDescription, unwrapShell } from './codex-app-server'

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
    expect(tools[1]?.description).toBe('读取 codex.txt')
    expect(ofKind(items, 'approval').map((approval) => [approval.tool, approval.resolution, approval.toolItemId])).toEqual([
      ['fileChange', 'allowed', tools[0]?.id],
      ['commandExecution', 'allowed', tools[1]?.id]
    ])
    expect(ofKind(items, 'turn').map((turn) => turn.state)).toEqual(['completed', 'interrupted', 'completed'])
    expect(ofKind(items, 'assistant').map((item) => item.streaming)).not.toContain(true)
    expect(driver.activity()).toBe('idle')
  })

  it('keeps each turn its own token count from the thread usage updates', () => {
    const turns = ofKind(replay(fixture('codex-session.jsonl')).items.list(), 'turn')
    expect(turns.length).toBeGreaterThan(0)
    for (const turn of turns) {
      expect(turn.usage).not.toBeNull()
      expect(turn.usage!.input).toBeGreaterThan(0)
      expect(turn.usage!.output).toBeGreaterThan(0)
    }
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
    expect(driver.send('go').wire).toMatchObject({
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
    expect(allowed.send('go').wire).toMatchObject({ params: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } })
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
    const turn = driver.send('Plan a README').wire
    driver.apply({ dir: 'out', at, frame: turn, ref: 'ref-1' })
    const plan = (id: string, text: string) => {
      driver.apply({ dir: 'in', at, frame: { method: 'item/completed', params: { item: { type: 'plan', id, text } } } })
      driver.apply({ dir: 'in', at, frame: { method: 'turn/completed', params: { turn: { id: `turn-${id}`, status: 'completed', error: null } } } })
    }
    plan('p1', '1. Write README.md')
    return { driver, turn, plan }
  }
  const modeOf = (driver: CodexAppServer) => ofKind(driver.items.list(), 'state')[0]?.permissionMode

  it('keeps a stage that may only plan in plan mode and read-only, and keeps its plan when asked', () => {
    const driver = new CodexAppServer('stage-1', { ...OPTIONS, planOnly: true, allowBypass: true, preferred: { permissionMode: 'acceptEdits' } })
    const { open } = handshake(driver, 'thread-1', { model: 'gpt-x' })
    expect(open).toMatchObject({ params: { approvalPolicy: 'on-request', sandbox: 'read-only' } })
    expect(ofKind(driver.items.list(), 'state')[0]).toMatchObject({ permissionMode: 'plan', permissionModes: ['plan'] })
    expect(() => driver.setOption('permissionMode', 'acceptEdits')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    const turn = driver.send('Plan a README').wire
    expect(turn).toMatchObject({ params: { sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan' } } })
    driver.apply({ dir: 'out', at, frame: turn, ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: { method: 'item/completed', params: { item: { type: 'plan', id: 'p1', text: '1. Write README.md' } } } })
    driver.apply({ dir: 'in', at, frame: { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', error: null } } } })
    expect(() => driver.respond('plan:p1', { decision: 'allowForSession' })).toThrow(expect.objectContaining({ reason: 'plan-only' }))
    const [kept] = driver.respond('plan:p1', { decision: 'deny', saved: true })
    expect(kept).toMatchObject({ params: { input: [{ text: expect.stringContaining('计划已保存') }], sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan' } } })
    driver.apply({ dir: 'out', at, frame: kept, ref: 'ref-2' })
    expect(driver.items.get('a:plan:p1')).toMatchObject({ resolution: 'denied' })
    expect(modeOf(driver)).toBe('plan')
  })

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
    expect(driver.send('next').wire).not.toHaveProperty('params.collaborationMode')
  })

  it('sends a plan back with a note, takes a message as more planning, and lets it go on exit', () => {
    const { driver, plan } = planned()
    const [again] = driver.respond('plan:p1', { decision: 'deny', message: 'Add a usage section' })
    expect(again).toMatchObject({ params: { input: [{ text: '继续规划：Add a usage section' }], collaborationMode: { mode: 'plan' } } })
    driver.apply({ dir: 'out', at, frame: again, ref: 'ref-2' })
    expect(driver.items.get('a:plan:p1')).toMatchObject({ resolution: 'denied' })
    expect(modeOf(driver)).toBe('plan')
    plan('p2', '1. Write README.md\n2. Add usage')
    const typed = driver.send('Shorter, please').wire
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
    expect(driver.send('go').wire).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thread-1', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/web'] } }
    })
  })

  it('denies with decline where Codex offers it and with cancel where it does not', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    driver.apply({ dir: 'out', at, frame: driver.send('go').wire, ref: 'ref-1' })
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
    driver.apply({ dir: 'out', at, frame: driver.send('go').wire, ref: 'ref-1' })
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
    driver.apply({ dir: 'out', at, frame: driver.send('go').wire, ref: 'ref-1' })
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

  it('puts a command in words from Codex\'s own reading of it, when every part is one Kando knows', () => {
    const read = (name: string) => ({ type: 'read', name, path: `/work/repo/${name}` })
    expect(commandDescription([read('a.ts'), read('b.ts')])).toBe('读取 a.ts、b.ts')
    expect(commandDescription([{ type: 'listFiles', path: 'src' }, read('a.ts')])).toBe('列出 src 里的文件，读取 a.ts')
    expect(commandDescription([{ type: 'search', query: 'TODO', path: 'src' }])).toBe('搜索「TODO」（src）')
    // One part it cannot read, or can only half say, leaves the command to speak for itself.
    expect(commandDescription([read('a.ts'), { type: 'unknown' }])).toBeNull()
    expect(commandDescription([{ type: 'listFiles', path: null }])).toBeNull()
    expect(commandDescription([{ type: 'search', query: null, path: 'src' }])).toBeNull()
    expect(commandDescription([])).toBeNull()
    expect(commandDescription(undefined)).toBeNull()
  })

  it('reads the script however Codex quoted it, as its own command actions do', () => {
    // Each pair as Codex 0.156.1 sent them: the command, and the script its commandActions named.
    const recorded = [
      ['/bin/zsh -lc pwd', 'pwd'],
      [`/bin/zsh -lc "python3 -c 'from pathlib import Path; Path(\\"plan.md\\").write_text(\\"ok\\\\n\\")'"`, `python3 -c 'from pathlib import Path; Path("plan.md").write_text("ok\\n")'`],
      [`/bin/zsh -lc "pwd && rg --files -g 'codex-plan.txt' -g '"'!target'"' -g '"'!node_modules'"' | head -n 20"`, "pwd && rg --files -g 'codex-plan.txt' -g '!target' -g '!node_modules' | head -n 20"],
      [`sh -c "echo \\$HOME and \\\\n kept"`, 'echo $HOME and \\n kept']
    ]
    for (const [command, script] of recorded) expect(unwrapShell(command!)).toBe(script)
    // Anything else is shown as it came: an open quote, a flag it does not know, more than a script.
    for (const command of [`/bin/zsh -lc 'unclosed`, '/bin/zsh -x ls', "bash -lc 'ls' extra", 'fish -c ls']) expect(unwrapShell(command)).toBe(command)
  })
  it('hands an image to Codex by its path, after the text when there is any', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    handshake(driver)
    const image = { id: `${'a'.repeat(64)}.png`, width: 4, height: 3, mime: 'image/png' as const, path: '/store/a.png', read: () => Uint8Array.from([]) }
    const { wire, logged } = driver.send('look', [image])
    expect(logged).toBe(wire)
    expect(wire).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: 'look', text_elements: [] }, { type: 'localImage', path: '/store/a.png' }] } })
    expect(driver.send('', [image]).wire).toMatchObject({ params: { input: [{ type: 'localImage', path: '/store/a.png' }] } })
    driver.apply({ dir: 'out', at, frame: wire, ref: 'ref-1', images: [{ id: image.id, width: 4, height: 3 }] })
    expect(driver.items.get('u:ref-1')).toMatchObject({ kind: 'user', text: 'look', images: [{ id: image.id, width: 4, height: 3 }] })
    expect(driver.takeMessages()).toEqual([{ role: 'user', text: 'look\n\n（附了 1 张图片）', eventKey: 'chat:ref-1:user', complete: false }])
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

describe('CodexAppServer subagents, as recorded', () => {
  // Codex 0.156.1: a turn that spawned one subagent and waited on it. The subagent's own thread
  // streams its items and turn on the same connection.
  const records = fixture('codex-subagent.jsonl')
  const child = '01a0ec12-779d-7c02-af68-8b645a8012e8'
  const text = (record: ChatRecord) => (record.dir === 'in' || record.dir === 'out' ? JSON.stringify(record.frame) : '')
  const childDone = records.findIndex((record) => text(record).startsWith(`{"method":"turn/completed","params":{"threadId":"${child}"`))
  const logs = (records: readonly ChatRecord[]) => {
    const logger = new CodexAppServer('stage-1', OPTIONS)
    return records.flatMap((record): ChatRecord[] => {
      logger.apply(record)
      if (record.dir !== 'in') return [record]
      const frame = logger.logged(record.frame)
      return frame === null ? [] : [{ ...record, frame }]
    })
  }

  it('shows the subagent as one call, with what it was told and what it reported', () => {
    const items = replay(records).items.list()
    const tools = ofKind(items, 'tool')
    expect(tools.map((tool) => [tool.name, tool.title, tool.status])).toEqual([
      ['spawnAgent', 'In the workspace, run `wc -l a.txt` and report the exact output. Do not do anything else.', 'done']
    ])
    expect(JSON.parse(tools[0]?.input ?? '')).toEqual({ prompt: 'In the workspace, run `wc -l a.txt` and report the exact output. Do not do anything else.' })
    expect(tools[0]?.output).toBe('       1 a.txt')
  })

  it('keeps the subagent\'s own thread out of the chat', () => {
    const driver = replay(records)
    const items = driver.items.list()
    expect(ofKind(items, 'assistant').map((item) => item.text)).toEqual([
      'I’ll delegate the line count to a subagent and wait for its result.',
      '`a.txt` contains 1 line.'
    ])
    expect(ofKind(items, 'turn').map((turn) => turn.state)).toEqual(['completed'])
    expect(ofKind(items, 'state')[0]?.context?.used).toBe(18_146)
    expect(childDone).toBeGreaterThan(0)
    expect(replay(records.slice(0, childDone + 1)).activity()).toBe('running')
  })

  it('logs only how the subagent\'s turns ended, and rebuilds the same items from that', () => {
    const kept = logs(records)
    const ofChild = (record: ChatRecord) => text(record).includes(`"threadId":"${child}"`)
    expect(records.filter(ofChild).length).toBeGreaterThan(10)
    expect(kept.filter(ofChild).map((record) => /"method":"([^"]+)"/.exec(text(record))?.[1])).toEqual(['turn/completed'])
    expect(shown(replay(kept).items.list())).toEqual(shown(replay(records).items.list()))
  })

  it('settles a subagent it does not wait on by the subagent\'s own turn', () => {
    const spawned = records.findIndex((record) => text(record).includes('"tool":"spawnAgent","status":"completed"'))
    const driver = replay([...records.slice(0, spawned + 1), records[childDone]!])
    expect(ofKind(driver.items.list(), 'tool').map((tool) => [tool.status, tool.output])).toEqual([['done', '       1 a.txt']])
  })
})

describe('CodexAppServer subagents', () => {
  const thread = 'thread-main'
  const opened = (): CodexAppServer => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    driver.apply({ dir: 'out', at: 1, frame: { id: 'kando-thread', method: 'thread/start', params: {} } })
    driver.apply({ dir: 'in', at: 2, frame: { id: 'kando-thread', result: { thread: { id: thread } } } })
    driver.apply({ dir: 'out', at: 3, frame: { id: 'kando-turn-1', method: 'turn/start', params: { threadId: thread, input: [{ type: 'text', text: 'go' }] } }, ref: 'ref-1' })
    return driver
  }
  const collab = (id: string, tool: string, status: string, receiverThreadIds: string[], agentsStates: Record<string, { status: string; message: string | null }>) => ({
    type: 'collabAgentToolCall', id, tool, status, senderThreadId: thread, receiverThreadIds, prompt: tool === 'spawnAgent' ? 'Look around\nand report' : null, agentsStates
  })
  const item = (driver: CodexAppServer, at: number, body: object, completed = true) =>
    driver.apply({ dir: 'in', at, frame: { method: completed ? 'item/completed' : 'item/started', params: { threadId: thread, item: body } } })
  const agentOf = (driver: CodexAppServer) => driver.items.get('t:spawn-1')

  it('runs while it works, and fails with what it said when it errors', () => {
    const driver = opened()
    item(driver, 4, collab('spawn-1', 'spawnAgent', 'inProgress', [], {}), false)
    expect(agentOf(driver)).toMatchObject({ kind: 'tool', name: 'spawnAgent', title: 'Look around', status: 'running', output: null })
    item(driver, 5, collab('spawn-1', 'spawnAgent', 'completed', ['child-1'], { 'child-1': { status: 'pendingInit', message: null } }))
    expect(agentOf(driver)).toMatchObject({ status: 'running' })
    item(driver, 6, collab('wait-1', 'wait', 'completed', ['child-1'], { 'child-1': { status: 'errored', message: 'ran out of turns' } }))
    expect(agentOf(driver)).toMatchObject({ status: 'failed', output: 'ran out of turns' })
    expect(driver.items.get('t:wait-1')).toBeUndefined()
  })

  it('stays done when closed after finishing, and is interrupted when closed before', () => {
    const driver = opened()
    item(driver, 4, collab('spawn-1', 'spawnAgent', 'completed', ['child-1'], { 'child-1': { status: 'running', message: null } }))
    item(driver, 5, collab('spawn-2', 'spawnAgent', 'completed', ['child-2'], { 'child-2': { status: 'running', message: null } }))
    item(driver, 6, collab('wait-1', 'wait', 'completed', ['child-1'], { 'child-1': { status: 'completed', message: 'found it' } }))
    item(driver, 7, collab('close-1', 'closeAgent', 'completed', ['child-1', 'child-2'], {
      'child-1': { status: 'shutdown', message: null },
      'child-2': { status: 'shutdown', message: null }
    }))
    expect(agentOf(driver)).toMatchObject({ status: 'done', output: 'found it' })
    expect(driver.items.get('t:spawn-2')).toMatchObject({ status: 'interrupted' })
  })

  it('fails a spawn Codex refused, and interrupts subagents still at work when the agent exits', () => {
    const driver = opened()
    item(driver, 4, collab('spawn-1', 'spawnAgent', 'failed', [], {}))
    expect(agentOf(driver)).toMatchObject({ status: 'failed' })
    item(driver, 5, collab('spawn-2', 'spawnAgent', 'completed', ['child-2'], { 'child-2': { status: 'running', message: null } }))
    driver.apply({ dir: 'in', at: 6, frame: { method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } } })
    expect(driver.items.get('t:spawn-2')).toMatchObject({ status: 'running' })
    driver.apply({ dir: 'exit', at: 7, code: 0, stderr: '' })
    expect(driver.items.get('t:spawn-2')).toMatchObject({ status: 'interrupted' })
  })

  it('asks for a subagent\'s approval here, naming the files it would change', () => {
    const driver = opened()
    const childItem = { type: 'fileChange', id: 'edit-1', status: 'inProgress', changes: [{ path: '/work/repo/b.txt', kind: { type: 'add' }, diff: '+b' }] }
    const started = { method: 'item/started', params: { threadId: 'child-1', item: childItem } }
    driver.apply({ dir: 'in', at: 4, frame: started })
    expect(driver.logged(started)).toEqual(started)
    driver.apply({ dir: 'in', at: 5, frame: { id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 'child-1', itemId: 'edit-1' } } })
    expect(ofKind(driver.items.list(), 'tool')).toEqual([])
    expect(ofKind(driver.items.list(), 'approval')[0]).toMatchObject({ tool: 'fileChange', title: '/work/repo/b.txt', detail: '子 agent 的请求' })
    driver.apply({ dir: 'in', at: 6, frame: { method: 'serverRequest/resolved', params: { threadId: 'child-1', requestId: 7 } } })
    expect(ofKind(driver.items.list(), 'approval')[0]?.resolution).toBe('cancelled')
  })
})
