import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { ChatRecord } from './chat-driver'
import { parseChatRecord } from './chat-log'
import { ClaudeStream } from './claude-stream'

const OPTIONS = { cwd: '/work/repo', extraDirs: [], resume: null }

// Recorded from Claude Code 2.1.282 (claude -p stream-json, --model haiku), then stripped of local paths.
function fixture(name: string): ChatRecord[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const record = line.trim() ? parseChatRecord(line) : null
      return record ? [record] : []
    })
}

function replay(records: readonly ChatRecord[]): ClaudeStream {
  const driver = new ClaudeStream('stage-1', OPTIONS)
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

  it('rebuilds the same items from what it logs as from everything it saw', () => {
    const records = fixture('claude-session.jsonl')
    const live = replay(records)
    const logger = new ClaudeStream('stage-1', OPTIONS)
    const kept = records.flatMap((record): ChatRecord[] => {
      if (record.dir !== 'in') return [record]
      const frame = logger.logged(record.frame)
      return frame === null ? [] : [{ ...record, frame }]
    })
    expect(kept.length).toBeLessThan(records.length / 2)
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
    const [question] = ofKind(items, 'question')
    expect(question?.questions[0]).toMatchObject({ question: 'Which beverage do you prefer?', multiSelect: false })
    expect(question?.questions[0]?.options.map((option) => option.label)).toEqual(['Tea', 'Coffee'])
    expect(question).toMatchObject({ resolution: 'answered', answers: { 'Which beverage do you prefer?': ['Coffee'] } })
  })
})

describe('ClaudeStream commands', () => {
  const at = 1
  const started = () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const [init] = driver.due()
    driver.apply({ dir: 'out', at, frame: init })
    driver.apply({ dir: 'in', at, frame: { type: 'control_response', response: { subtype: 'success', request_id: 'kando-init' } } })
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
