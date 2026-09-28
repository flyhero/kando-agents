import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import type { StageMessage } from './chat-driver'
import { ChatHost, type ChatSink, type ChatStage } from './chat-host'
import { fakeChatDaemon } from './fake-chat-agent'

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
  let activityChanges = 0
  const sink: ChatSink = {
    items: (_conversationId, changed) => items.push(...changed),
    delta: () => {},
    messages: (_stage, added) => messages.push(...added),
    provider: () => {},
    activity: () => { activityChanges++ },
    offset: (_stageId, end) => offsets.push(end)
  }
  return { sink, items, messages, offsets, activity: () => activityChanges }
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

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-host-'))
    daemon = fakeChatDaemon()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function started(sink: ChatSink = recordingSink().sink) {
    const host = new ChatHost(daemon, root, sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') host.handleData(event.sessionId, event.offset, event.data)
      if (event.event === 'exit') host.handleExit(event.sessionId, event.exitCode)
    }
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    await host.open(STAGE, sessionId, 0, true)
    return { host, sessionId }
  }

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
    const restarted = new ChatHost(daemon, root, second.sink)
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
    const host = new ChatHost(daemon, root, recordingSink().sink)
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

  it('notes a hole in the output instead of reading half a frame', async () => {
    const host = new ChatHost(daemon, root, recordingSink().sink)
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
    const host = new ChatHost(daemon, root, recordingSink().sink)
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
})
