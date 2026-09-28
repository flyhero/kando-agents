import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { ChatRecord, ChatStageOptions } from './chat-driver'
import { parseChatRecord } from './chat-log'
import { ClaudeStream } from './claude-stream'

const OPTIONS: ChatStageOptions = { cwd: '/work/repo', extraDirs: [], resume: null }

// Recorded from Claude Code 2.1.282 (claude -p stream-json, --model haiku), then stripped of local paths.
function fixture(name: string): ChatRecord[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const record = line.trim() ? parseChatRecord(line) : null
      return record ? [record] : []
    })
}

function replay(records: readonly ChatRecord[], options: ChatStageOptions = OPTIONS): ClaudeStream {
  const driver = new ClaudeStream('stage-1', options)
  records.forEach((record) => driver.apply(record))
  return driver
}

const ofKind = <K extends ChatItem['kind']>(items: ChatItem[], kind: K) =>
  items.filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

// Items as the chat view shows them. Revisions count the updates that led there, and a streamed
// item is first seen when its text starts rather than when its complete frame arrives.
const shown = (items: ChatItem[]) => items.map(({ revision: _revision, at: _at, ...item }) => item)

describe('ClaudeStream', () => {
  it('turns a recorded session into messages, tool calls, an approval and turn outcomes', () => {
    const driver = replay(fixture('claude-session.jsonl'))
    const items = driver.items.list()

    expect(ofKind(items, 'user').map((item) => item.text)).toEqual([
      'Create a file named hello.txt containing the single word hi, then run `cat hello.txt` with the Bash tool. Answer in one short sentence.',
      'Use the Read tool to read hello.txt and tell me what it says, in one sentence.',
      'Count from 1 to 300, one number per line, no other text.',
      'Say "done" and nothing else.'
    ])
    const assistant = ofKind(items, 'assistant')
    expect(assistant.map((item) => item.streaming)).toEqual([false, false, false, false])
    expect(assistant.map((item) => item.text.split('\n')[0])).toEqual([
      'File created and `cat hello.txt` displays: hi',
      'The file contains the single word "hi".',
      '1',
      'done'
    ])

    const tools = ofKind(items, 'tool')
    expect(tools.map((tool) => [tool.name, tool.title, tool.status])).toEqual([
      ['Write', '/work/repo/hello.txt', 'done'],
      ['Bash', 'cat hello.txt', 'done'],
      ['Read', '/work/repo/hello.txt', 'done']
    ])
    expect(tools[0]?.diffs).toEqual([{ path: '/work/repo/hello.txt', change: 'add', patch: '+hi' }])
    expect(tools[1]?.output).toBe('hi')

    const [approval] = ofKind(items, 'approval')
    expect(approval).toMatchObject({ tool: 'Write', title: '/work/repo/hello.txt', resolution: 'allowed', toolItemId: tools[0]?.id })
    expect(approval?.decisions).toEqual(['allow', 'allowForSession', 'deny'])

    expect(ofKind(items, 'turn').map((turn) => turn.state)).toEqual(['completed', 'completed', 'interrupted', 'completed'])
    expect(driver.activity()).toBe('idle')
    expect(driver.ready()).toBe(false)
    expect(driver.providerSessionId()).toBe('6f81960b-d2d8-4380-a15d-efb1386b5db5')
  })

  it('records one user and one final assistant message per turn under keys a replay repeats', () => {
    const messages = replay(fixture('claude-session.jsonl')).takeMessages()
    expect(messages.filter((message) => message.role === 'user').map((message) => message.eventKey))
      .toEqual(['chat:ref-1:user', 'chat:ref-2:user', 'chat:ref-3:user', 'chat:ref-4:user'])
    expect(messages.find((message) => message.eventKey === 'chat:ref-1:assistant')?.text)
      .toBe('File created and `cat hello.txt` displays: hi')
    expect(replay(fixture('claude-session.jsonl')).takeMessages()).toEqual(messages)
  })

  it.each(['claude-session.jsonl', 'claude-options.jsonl'])('rebuilds the same items from what it logs as from everything it saw (%s)', (name) => {
    const records = fixture(name)
    const live = replay(records)
    const logger = new ClaudeStream('stage-1', OPTIONS)
    const kept = records.flatMap((record): ChatRecord[] => {
      if (record.dir !== 'in') return [record]
      const frame = logger.logged(record.frame)
      return frame === null ? [] : [{ ...record, frame }]
    })
    expect(kept.length).toBeLessThan(name === 'claude-session.jsonl' ? records.length / 2 : records.length)
    expect(shown(replay(kept).items.list())).toEqual(shown(live.items.list()))
  })

  it('streams text into an item that the complete frame then finishes', () => {
    const records = fixture('claude-session.jsonl')
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const counting = records.findIndex((record) => record.dir === 'out' && JSON.stringify(record.frame).includes('Count from 1'))
    records.slice(0, counting + 1).forEach((record) => driver.apply(record))
    driver.items.drain()
    let streamed = ''
    let started: ChatItem | undefined
    for (const record of records.slice(counting + 1)) {
      driver.apply(record)
      const { items, deltas } = driver.items.drain()
      started ??= items.find((item) => item.kind === 'assistant' && item.streaming)
      streamed += deltas.map((delta) => delta.append).join('')
      if (items.some((item) => item.kind === 'turn')) break
    }
    expect(started).toBeDefined()
    expect(streamed.startsWith('1\n2\n3')).toBe(true)
    const finished = driver.items.get(started?.id ?? '')
    expect(finished).toMatchObject({ kind: 'assistant', streaming: false })
    expect(ofKind(driver.items.list(), 'assistant').filter((item) => item.text.startsWith('1\n'))).toHaveLength(1)
  })

  it('marks a denied call and records the answer to a question', () => {
    const items = replay(fixture('claude-approvals.jsonl')).items.list()
    const [write] = ofKind(items, 'tool')
    expect(write).toMatchObject({ name: 'Write', status: 'denied' })
    const [approval] = ofKind(items, 'approval')
    expect(approval?.resolution).toBe('denied')
    expect(ofKind(items, 'tool').map((tool) => tool.name)).toEqual(['Write'])
    const [question] = ofKind(items, 'question')
    expect(question?.questions[0]).toMatchObject({ question: 'Which beverage do you prefer?', multiSelect: false })
    expect(question?.questions[0]?.options.map((option) => option.label)).toEqual(['Tea', 'Coffee'])
    expect(question).toMatchObject({ resolution: 'answered', answers: { 'Which beverage do you prefer?': ['Coffee'] } })
  })
})

describe('ClaudeStream state', () => {
  // Plan mode, two TaskCreate calls, ExitPlanMode approved into acceptEdits, then TaskUpdate and TaskList.
  const records = fixture('claude-options.jsonl')
  const stateOf = (driver: ClaudeStream) => ofKind(driver.items.list(), 'state')[0]

  it('reports the mode, model, effort and context the stage runs with', () => {
    const state = stateOf(replay(records))
    expect(state).toMatchObject({ permissionMode: 'acceptEdits', model: 'haiku', permissionModes: ['ask', 'acceptEdits', 'plan'] })
    expect(state?.models.map((model) => model.id)).toContain('sonnet')
    expect(state?.models.find((model) => model.id === 'sonnet')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(state?.context?.window).toBe(200_000)
    expect(state?.context?.used).toBeGreaterThan(10_000)
  })

  it('follows the permission mode as the CLI reports it change', () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const modes: Array<string | null> = []
    for (const record of records) {
      driver.apply(record)
      const mode = stateOf(driver)?.permissionMode ?? null
      if (modes.at(-1) !== mode) modes.push(mode)
    }
    expect(modes).toEqual([null, 'ask', 'plan', 'acceptEdits'])
  })

  it('knows the model before the first turn reports it', () => {
    const init = records.findIndex((record) => record.dir === 'in' && JSON.stringify(record.frame).includes('"subtype":"init"'))
    const before = records.slice(0, init)
    expect(stateOf(replay(before))).toMatchObject({ model: 'opus', permissionModes: ['ask', 'acceptEdits', 'plan', 'auto'] })
    expect(stateOf(replay(before, { ...OPTIONS, preferred: { model: 'sonnet' } }))?.model).toBe('sonnet')
  })

  it('reports the effort it was started with, which the settings leave out', () => {
    const settled = records.findIndex((record) => record.dir === 'in' && JSON.stringify(record.frame).includes('"request_id":"kando-settings"'))
    const before = records.slice(0, settled + 1)
    expect(stateOf(replay(before))?.effort).toBeNull()
    expect(stateOf(replay(before, { ...OPTIONS, preferred: { effort: 'low' } }))?.effort).toBe('low')
  })

  it('offers auto only for a model that has it, and bypass only when the user allows it', () => {
    const allowed = replay(records.map((record) => record), { ...OPTIONS, allowBypass: true })
    expect(stateOf(allowed)?.permissionModes).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
  })

  it('turns task tool calls into a checklist instead of tool cards', () => {
    const driver = replay(records)
    const items = driver.items.list()
    expect(ofKind(items, 'tool').map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['TaskCreate', 'TaskUpdate', 'TaskList', 'ToolSearch']))
    expect(stateOf(driver)?.todos).toEqual([
      { content: 'Create notes.md file', status: 'completed', activeForm: null },
      { content: 'Write two short lines to notes.md', status: 'completed', activeForm: null }
    ])
    // The first turn created and finished both; the second listed them unchanged.
    expect(ofKind(items, 'todos').map((item) => item.id)).toEqual(['todos:ref-1'])
  })

  it('shows the plan an ExitPlanMode call proposes, and not the draft it wrote first', () => {
    const tools = ofKind(replay(records).items.list(), 'tool')
    const [plan] = tools.filter((tool) => tool.name === 'ExitPlanMode')
    expect(plan).toMatchObject({ title: '计划', status: 'done' })
    expect(plan?.input).toContain('# Add notes.md')
    expect(tools.map((tool) => tool.title)).not.toContainEqual(expect.stringContaining('/.claude/plans/'))
    expect(tools.filter((tool) => tool.name === 'Write')).toHaveLength(1)
  })

  it('keeps no account details from initialize in what it logs', () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const kept = driver.logged({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'kando-init', response: { account: { email: 'someone@example.com' }, commands: [{ name: 'x' }], current_permission_mode: 'default', models: [] } }
    })
    expect(JSON.stringify(kept)).not.toContain('example.com')
    expect(JSON.stringify(kept)).not.toContain('commands')
  })
})

describe('ClaudeStream options', () => {
  // The recorded stage, still running: everything but its exit.
  const live = () => replay(fixture('claude-options.jsonl').filter((record) => record.dir !== 'exit'))
  const at = 2

  it('switches the permission mode, even mid-turn, to one the stage offers', () => {
    const driver = live()
    expect(driver.setOption('permissionMode', 'ask')).toEqual([
      { type: 'control_request', request_id: 'kando-option-2', request: { subtype: 'set_permission_mode', mode: 'default' } }
    ])
    expect(() => driver.setOption('permissionMode', 'bypass')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    expect(() => driver.setOption('permissionMode', 'readOnly')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
  })

  it('switches the model and effort between turns only, to what the catalog lists', () => {
    const driver = live()
    const [frame] = driver.setOption('model', 'sonnet')
    expect(frame).toMatchObject({ request: { subtype: 'set_model', model: 'sonnet' } })
    expect(() => driver.setOption('model', 'gpt-6-sol')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    // Haiku takes no effort at all.
    expect(() => driver.setOption('effort', 'high')).toThrow(expect.objectContaining({ reason: 'chat-option-invalid' }))
    driver.apply({ dir: 'out', at, frame })
    driver.apply({ dir: 'in', at, frame: { type: 'control_response', response: { subtype: 'success', request_id: 'kando-option-2' } } })
    const state = ofKind(driver.items.list(), 'state')[0]
    expect(state?.model).toBe('sonnet')
    const [effort] = driver.setOption('effort', 'high')
    expect(effort).toMatchObject({ request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } })
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-9' })
    expect(() => driver.setOption('model', 'haiku')).toThrow(expect.objectContaining({ reason: 'chat-busy' }))
  })

  it('says so when the CLI refuses a switch', () => {
    const driver = live()
    driver.apply({ dir: 'out', at, frame: driver.setOption('model', 'sonnet')[0] })
    driver.apply({ dir: 'in', at, frame: { type: 'control_response', response: { subtype: 'error', request_id: 'kando-option-2', error: "Model 'sonnet' not found" } } })
    expect(ofKind(driver.items.list(), 'notice').at(-1)?.text).toContain("Model 'sonnet' not found")
    expect(ofKind(driver.items.list(), 'state')[0]?.model).toBe('haiku')
  })

  it('carries out an approved plan asking each edit, or taking edits as they come', () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    driver.apply({ dir: 'out', at, frame: { type: 'control_request', request_id: 'kando-init', request: { subtype: 'initialize' } } })
    driver.apply({ dir: 'in', at, frame: { type: 'control_response', response: { subtype: 'success', request_id: 'kando-init' } } })
    driver.apply({ dir: 'out', at, frame: driver.send('plan it'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: { type: 'control_request', request_id: 'plan-1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: 'toolu_p' } } })
    expect(driver.items.get('a:plan-1')).toMatchObject({ detail: '# Plan', decisions: ['allow', 'allowForSession', 'deny'] })
    const [accept] = driver.respond('plan-1', { decision: 'allowForSession' })
    expect(accept).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } })
    expect(driver.respond('plan-1', { decision: 'allow' })[0]).toMatchObject({ response: { response: { updatedPermissions: [{ mode: 'default' }] } } })
    expect(driver.respond('plan-1', { decision: 'deny', message: 'split step 2' })[0])
      .toMatchObject({ response: { response: { behavior: 'deny', message: 'Keep planning. split step 2' } } })
    driver.apply({ dir: 'out', at, frame: accept })
    expect(driver.items.get('a:plan-1')).toMatchObject({ resolution: 'allowedForSession' })
  })
})

describe('ClaudeStream commands', () => {
  const at = 1
  const started = () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const [init] = driver.due()
    driver.apply({ dir: 'out', at, frame: init })
    driver.apply({ dir: 'in', at, frame: { type: 'control_response', response: { subtype: 'success', request_id: 'kando-init' } } })
    const [settings] = driver.due()
    expect(settings).toMatchObject({ request_id: 'kando-settings', request: { subtype: 'get_settings' } })
    driver.apply({ dir: 'out', at, frame: settings })
    return driver
  }
  const canUseTool = (requestId: string) => ({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_1',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' }]
    }
  })

  it('initializes before anything else and refuses a message until the agent answers', () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    expect(driver.due()).toEqual([{ type: 'control_request', request_id: 'kando-init', request: { subtype: 'initialize' } }])
    driver.apply({ dir: 'out', at, frame: driver.due()[0] })
    expect(driver.due()).toEqual([])
    expect(() => driver.send('hi')).toThrow(expect.objectContaining({ reason: 'chat-starting' }))
  })

  it('takes one message at a time and waits on approvals', () => {
    const driver = started()
    const frame = driver.send('clean up')
    expect(frame).toEqual({ type: 'user', message: { role: 'user', content: 'clean up' } })
    driver.apply({ dir: 'out', at, frame, ref: 'ref-1' })
    expect(driver.activity()).toBe('running')
    expect(() => driver.send('again')).toThrow(expect.objectContaining({ reason: 'chat-busy' }))

    driver.apply({ dir: 'in', at, frame: canUseTool('req-1') })
    expect(driver.activity()).toBe('awaiting')
    expect(driver.respond('req-1', { decision: 'allowForSession' })).toEqual([{
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { command: 'rm -rf build' }, updatedPermissions: canUseTool('').request.permission_suggestions }
      }
    }])
    driver.apply({ dir: 'out', at, frame: driver.respond('req-1', { decision: 'allowForSession' })[0] })
    expect(driver.activity()).toBe('running')
    expect(driver.items.get('a:req-1')).toMatchObject({ resolution: 'allowedForSession' })
    expect(() => driver.respond('req-1', { decision: 'deny' })).toThrow(expect.objectContaining({ reason: 'chat-request-gone' }))
  })

  it('interrupts by denying what waits and asking the agent to stop', () => {
    const driver = started()
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: canUseTool('req-2') })
    const frames = driver.interrupt()
    expect(frames).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'req-2', response: { behavior: 'deny', message: 'The user interrupted the turn.', interrupt: true } } },
      { type: 'control_request', request_id: 'kando-interrupt-1', request: { subtype: 'interrupt' } }
    ])
    frames.forEach((frame) => driver.apply({ dir: 'out', at, frame }))
    expect(driver.interrupt().at(-1)).toMatchObject({ request_id: 'kando-interrupt-2' })
    // Stopping decided nothing about the call itself.
    expect(driver.items.get('a:req-2')).toMatchObject({ resolution: 'cancelled' })
  })

  it('marks calls the user stopped as interrupted rather than failed', () => {
    const driver = started()
    const call = (id: string, command: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    const failed = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Exit code 1' }] } })
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: call('toolu_1', 'false') })
    driver.apply({ dir: 'in', at, frame: failed('toolu_1') })
    driver.apply({ dir: 'in', at, frame: call('toolu_2', 'sleep 4') })
    driver.apply({ dir: 'in', at, frame: call('toolu_3', 'sleep 5') })
    driver.interrupt().forEach((frame) => driver.apply({ dir: 'out', at, frame }))
    driver.apply({ dir: 'in', at, frame: failed('toolu_2') })
    driver.apply({ dir: 'in', at, frame: { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' } })
    expect(ofKind(driver.items.list(), 'tool').map((tool) => [tool.title, tool.status])).toEqual([
      ['false', 'failed'],
      ['sleep 4', 'interrupted'],
      ['sleep 5', 'interrupted']
    ])
  })

  it('answers a control request it does not handle with an error, once', () => {
    const driver = started()
    driver.apply({ dir: 'in', at, frame: { type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback' } } })
    const [reply] = driver.due()
    expect(reply).toMatchObject({ type: 'control_response', response: { subtype: 'error', request_id: 'hook-1' } })
    driver.apply({ dir: 'out', at, frame: reply })
    expect(driver.due()).toEqual([])
  })

  it('closes what an exit leaves open and says why a start failed', () => {
    const early = new ClaudeStream('stage-1', OPTIONS)
    early.apply({ dir: 'out', at, frame: early.due()[0] })
    early.apply({ dir: 'exit', at, code: 1, stderr: 'Invalid API key' })
    expect(early.failure()).toBe('exited')
    expect(ofKind(early.items.list(), 'notice')[0]?.text).toContain('Invalid API key')

    const driver = started()
    driver.apply({ dir: 'out', at, frame: driver.send('go'), ref: 'ref-1' })
    driver.apply({ dir: 'in', at, frame: canUseTool('req-3') })
    driver.apply({ dir: 'exit', at, code: 143, stderr: '' })
    expect(driver.items.get('a:req-3')).toMatchObject({ resolution: 'cancelled' })
    expect(driver.items.get('turn:ref-1')).toMatchObject({ state: 'interrupted' })
    expect(driver.activity()).toBe('idle')
  })
})
