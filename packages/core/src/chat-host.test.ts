import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { StageMessage } from './chat-driver'
import type { UsageReport } from './usage-source'
import { ChatHost, type ChatSink, type ChatStage } from './chat-host'
import { AttachmentStore } from './attachment-store'
import { ChatLog } from './chat-log'
import { fakeChatDaemon } from './fake-chat-agent'
import { pngBytes } from './image-fixtures'

const STAGE: ChatStage = {
  conversationId: 'conversation-1',
  stageId: 'stage-1',
  agent: 'claude',
  options: { cwd: '/work/repo', extraDirs: [], resume: null }
}

function recordingSink() {
  const items: ChatItem[] = []
  const messages: StageMessage[] = []
  const offsets: number[] = []
  const usage: UsageReport[] = []
  let activityChanges = 0
  const sink: ChatSink = {
    items: (_conversationId, changed) => items.push(...changed),
    delta: () => {},
    messages: (_stage, added) => messages.push(...added),
    provider: () => {},
    activity: () => { activityChanges++ },
    offset: (_stageId, end) => offsets.push(end),
    usage: (_stage, report) => usage.push(report)
  }
  return { sink, items, messages, offsets, usage, activity: () => activityChanges }
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))
// The stage's state item is not part of the conversation's flow.
const kinds = (items: ChatItem[]) => items.filter((item) => item.kind !== 'state').map((item) => item.kind)
const canUseTool = (requestId: string) => ({
  type: 'control_request',
  request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' }
})

describe('ChatHost', () => {
  let root: string
  let daemon: ReturnType<typeof fakeChatDaemon>
  let attachments: AttachmentStore

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-host-'))
    mkdirSync(path.join(root, 'attachments'))
    attachments = new AttachmentStore(path.join(root, 'attachments'))
    daemon = fakeChatDaemon()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function started(sink: ChatSink = recordingSink().sink) {
    const host = new ChatHost(daemon, root, attachments, sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') host.handleData(event.sessionId, event.offset, event.data)
      if (event.event === 'exit') host.handleExit(event.sessionId, event.exitCode)
    }
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    await host.open(STAGE, sessionId, 0, true)
    return { host, sessionId }
  }

  it('shows what an ended stage left asking as no longer waiting', () => {
    // An agent killed while core was down leaves no exit behind to close what it asked.
    ChatLog.of(root, STAGE.conversationId, STAGE.stageId).append([{ dir: 'in', at: 1, frame: canUseTool('req-1') }])
    const host = new ChatHost(daemon, root, attachments, recordingSink().sink)
    const resolution = (stage: ChatStage) => host.items(stage).find((item) => item.kind === 'approval')
    expect(resolution(STAGE)).toMatchObject({ resolution: null })
    expect(resolution({ ...STAGE, ended: true })).toMatchObject({ resolution: 'cancelled' })
  })

  it('initializes the agent, then carries a message and its reply', async () => {
    const recorded = recordingSink()
    const { host, sessionId } = await started(recorded.sink)
    expect(daemon.written(sessionId)).toEqual([
      { type: 'control_request', request_id: 'kando-init', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'kando-settings', request: { subtype: 'get_settings' } }
    ])

    const reply = daemon.reply
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'hello')
    expect(host.activity(STAGE.conversationId)).toBe('running')
    reply(sessionId, 'hello')
    expect(host.activity(STAGE.conversationId)).toBe('idle')
    expect(kinds(host.items(STAGE))).toEqual(['user', 'assistant', 'turn'])
    expect(recorded.messages.map((message) => [message.role, message.text])).toEqual([['user', 'hello'], ['assistant', 'echo: hello']])
    expect(recorded.offsets.at(-1)).toBe(daemon.sessions.get(sessionId)?.output.length)
  })

  it('picks a stage up after a restart without reading or sending anything twice', async () => {
    const first = recordingSink()
    const { host, sessionId } = await started(first.sink)
    await host.send(STAGE.conversationId, 'hello')
    await flushMicrotasks()
    daemon.reply = (id) => daemon.emit(id, canUseTool('req-1'))
    await host.send(STAGE.conversationId, 'list the files')
    await flushMicrotasks()
    const before = host.items(STAGE)
    const sent = daemon.written(sessionId).length

    // A new core: same log on disk, the daemon still holds all of the session's output.
    const second = recordingSink()
    const restarted = new ChatHost(daemon, root, attachments, second.sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') restarted.handleData(event.sessionId, event.offset, event.data)
    }
    await restarted.open(STAGE, sessionId, first.offsets.at(-1) ?? 0, false)
    expect(restarted.items(STAGE).map(({ revision: _revision, ...item }) => item))
      .toEqual(before.map(({ revision: _revision, ...item }) => item))
    expect(daemon.written(sessionId)).toHaveLength(sent)
    expect(restarted.activity(STAGE.conversationId)).toBe('awaiting')

    await restarted.respond(STAGE.conversationId, 'req-1', { decision: 'allow' })
    expect(daemon.written(sessionId).at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'req-1' } })
    expect(restarted.items(STAGE).find((item) => item.kind === 'approval')).toMatchObject({ resolution: 'allowed' })
  })

  it('holds output that arrives while it reads the buffer, and feeds it once, in order', async () => {
    const host = new ChatHost(daemon, root, attachments, recordingSink().sink)
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    daemon.answerInit = false
    const init = `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'kando-init' } })}\n`
    const assistant = `${JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'early' }] } })}\n`
    const session = daemon.sessions.get(sessionId)!
    session.output = init
    const opening = host.open(STAGE, sessionId, 0, true)
    // Both chunks arrive before the attach reply; the first is also in the buffer attach returns.
    host.handleData(sessionId, 0, init)
    session.output += assistant
    host.handleData(sessionId, init.length, assistant)
    await opening
    expect(host.items(STAGE).filter((item) => item.kind === 'assistant').map((item) => item.kind === 'assistant' && item.text)).toEqual(['early'])
  })

  const stateOf = (host: ChatHost) => host.items(STAGE).find((item) => item.kind === 'state')
  const userFrames = (sessionId: string) => daemon.written(sessionId).filter((frame) => JSON.stringify(frame).includes('"type":"user"'))
  const finish = (sessionId: string, terminal: 'completed' | 'aborted_streaming') =>
    daemon.emit(sessionId, { type: 'result', subtype: terminal === 'completed' ? 'success' : 'error_during_execution', is_error: terminal !== 'completed', terminal_reason: terminal })

  it('sends a message whose sender names its ref at most once', async () => {
    const { host, sessionId } = await started()
    await host.send(STAGE.conversationId, 'go on', [], false, false, 'usage-limit:1')
    await flushMicrotasks()
    await host.send(STAGE.conversationId, 'go on', [], false, false, 'usage-limit:1')
    expect(userFrames(sessionId)).toHaveLength(1)
    expect(host.items(STAGE).filter((item) => item.kind === 'user').map((item) => item.id)).toEqual(['u:usage-limit:1'])
  })

  it('passes on the limits the agent reports while it runs', async () => {
    const recorded = recordingSink()
    const { sessionId } = await started(recorded.sink)
    daemon.emit(sessionId, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: null } } } })
    expect(recorded.usage).toEqual([{ at: expect.any(Number), windows: [expect.objectContaining({ kind: 'session', usedPercent: 50 })], refresh: false }])
  })

  it('sends a message queued during a turn once the turn completes', async () => {
    const { host, sessionId } = await started()
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'first')
    await host.send(STAGE.conversationId, 'second', [], true)
    expect(stateOf(host)).toMatchObject({ queued: { text: 'second', held: false } })
    expect(userFrames(sessionId)).toHaveLength(1)
    finish(sessionId, 'completed')
    await flushMicrotasks()
    expect(userFrames(sessionId).map((frame) => JSON.stringify(frame))).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second')
    ])
    expect(stateOf(host)).toMatchObject({ queued: null })
    expect(host.items(STAGE).filter((item) => item.kind === 'user').map((item) => item.kind === 'user' && item.text)).toEqual(['first', 'second'])
  })

  it('holds a queued message after an interrupted turn until the user sends or drops it', async () => {
    const { host, sessionId } = await started()
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'first')
    await host.send(STAGE.conversationId, 'second', [], true)
    finish(sessionId, 'aborted_streaming')
    await flushMicrotasks()
    expect(stateOf(host)).toMatchObject({ queued: { text: 'second', held: true } })
    expect(userFrames(sessionId)).toHaveLength(1)
    await host.sendQueued(STAGE.conversationId)
    await flushMicrotasks()
    expect(userFrames(sessionId)).toHaveLength(2)
    finish(sessionId, 'completed')
    await host.send(STAGE.conversationId, 'third', [], true)
    finish(sessionId, 'aborted_streaming')
    host.cancelQueued(STAGE.conversationId)
    expect(stateOf(host)).toMatchObject({ queued: null, queue: [] })
    await expect(host.sendQueued(STAGE.conversationId)).rejects.toMatchObject({ reason: 'chat-nothing-queued' })
  })

  it('sends queued messages one turn at a time, in the order they were written', async () => {
    const { host, sessionId } = await started()
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'first')
    await host.send(STAGE.conversationId, 'second', [], true)
    await host.send(STAGE.conversationId, 'third', [], true)
    expect(stateOf(host)).toMatchObject({ queued: { text: 'second' }, queue: [{ text: 'second', held: false }, { text: 'third', held: false }] })
    finish(sessionId, 'completed')
    await flushMicrotasks()
    // The second went out and started a turn; the third waits for that one.
    expect(userFrames(sessionId)).toHaveLength(2)
    expect(stateOf(host)).toMatchObject({ queue: [{ text: 'third' }] })
    finish(sessionId, 'completed')
    await flushMicrotasks()
    expect(userFrames(sessionId)).toHaveLength(3)
    expect(stateOf(host)).toMatchObject({ queue: [] })
  })

  it('drops one queued message by its ref and sends another into the running turn at once', async () => {
    const { host, sessionId } = await started()
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'first')
    await host.send(STAGE.conversationId, 'second', [], true)
    await host.send(STAGE.conversationId, 'third', [], true)
    const state = stateOf(host)
    const [second, third] = state?.kind === 'state' ? state.queue : []
    host.cancelQueued(STAGE.conversationId, second!.ref)
    expect(stateOf(host)).toMatchObject({ queue: [{ text: 'third' }] })
    await host.sendQueued(STAGE.conversationId, third!.ref, true)
    // Into the running turn: a user item marked as steering, the turn still the first's.
    expect(userFrames(sessionId)).toHaveLength(2)
    expect(stateOf(host)).toMatchObject({ queue: [], steerable: true })
    expect(host.items(STAGE).filter((item) => item.kind === 'user')).toMatchObject([{ text: 'first' }, { text: 'third', steer: true }])
    expect(host.activity(STAGE.conversationId)).toBe('running')
  })

  it('keeps a queued message across a restart and sends it when the turn ends', async () => {
    const first = recordingSink()
    const { host, sessionId } = await started(first.sink)
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'first')
    await host.send(STAGE.conversationId, 'second', [], true)
    const restarted = new ChatHost(daemon, root, attachments, recordingSink().sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') restarted.handleData(event.sessionId, event.offset, event.data)
    }
    await restarted.open(STAGE, sessionId, first.offsets.at(-1) ?? 0, false)
    expect(stateOf(restarted)).toMatchObject({ queued: { text: 'second', held: false } })
    finish(sessionId, 'completed')
    await flushMicrotasks()
    expect(userFrames(sessionId)).toHaveLength(2)
  })

  it('notes a hole in the output instead of reading half a frame', async () => {
    const host = new ChatHost(daemon, root, attachments, recordingSink().sink)
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    daemon.answerInit = false
    await host.open(STAGE, sessionId, 0, false)
    host.handleData(sessionId, 500, `"text":"cut"}}\n${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' })}\n`)
    const [notice] = host.items(STAGE).filter((item) => item.kind === 'notice')
    expect(notice).toMatchObject({ level: 'warning' })
  })

  it('closes a stage when its agent exits and lets the daemon drop the output', async () => {
    const { host, sessionId } = await started()
    await host.send(STAGE.conversationId, 'hello')
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'again').catch(() => {})
    daemon.exit(sessionId, 1)
    expect(host.owns(sessionId)).toBe(false)
    expect(daemon.released).toContain(sessionId)
    expect(host.activity(STAGE.conversationId)).toBeNull()
    // Still readable from the log once the process is gone.
    expect(kinds(host.items(STAGE))).toContain('user')
  })

  it('fails the start with what the agent printed when it exits before initializing', async () => {
    const host = new ChatHost(daemon, root, attachments, recordingSink().sink)
    daemon.deliver = (event) => {
      if (event.event === 'exit') host.handleExit(event.sessionId, event.exitCode)
    }
    daemon.answerInit = false
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    daemon.sessions.get(sessionId)!.stderr = 'Invalid API key · Please run /login'
    const opening = host.open(STAGE, sessionId, 0, true)
    queueMicrotask(() => daemon.exit(sessionId, 1))
    await expect(opening).rejects.toMatchObject({ reason: 'chat-start-failed', message: expect.stringContaining('Invalid API key') })
  })
  it('shows the agent a message\'s images and keeps only their names in the log', async () => {
    const recorded = recordingSink()
    const { host, sessionId } = await started(recorded.sink)
    const stored = await attachments.put(pngBytes(4, 3))
    const image = { id: stored.id, width: 4, height: 3 }
    daemon.reply = () => {}
    await host.send(STAGE.conversationId, 'what is this', [image])
    expect(userFrames(sessionId)[0]).toMatchObject({ message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }, { type: 'text', text: 'what is this' }] } })
    const log = readFileSync(path.join(root, STAGE.conversationId, 'stages', `${STAGE.stageId}.jsonl`), 'utf8')
    expect(log).not.toContain('base64')
    expect(log).toContain(stored.id)
    expect(host.items(STAGE).find((item) => item.kind === 'user')).toMatchObject({ text: 'what is this', images: [image] })
    expect(recorded.messages[0]).toMatchObject({ role: 'user', text: 'what is this\n\n（附了 1 张图片）' })

    // Queued with an image, a message goes out with it once the turn ends, after a restart too.
    await host.send(STAGE.conversationId, '', [image], true)
    expect(stateOf(host)).toMatchObject({ queued: { text: '', images: [image] } })
    const restarted = new ChatHost(daemon, root, attachments, recordingSink().sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') restarted.handleData(event.sessionId, event.offset, event.data)
    }
    await restarted.open(STAGE, sessionId, recorded.offsets.at(-1) ?? 0, false)
    finish(sessionId, 'completed')
    await flushMicrotasks()
    expect(userFrames(sessionId)).toHaveLength(2)
    expect(userFrames(sessionId)[1]).toMatchObject({ message: { content: [{ type: 'image' }] } })
    expect(restarted.items(STAGE).filter((item) => item.kind === 'user').at(-1)).toMatchObject({ text: '', images: [image] })
  })
})
