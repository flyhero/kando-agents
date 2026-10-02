import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import { AttachmentStore } from './attachment-store'
import { ChatHost, type ChatSink, type ChatStage } from './chat-host'
import { fakeChatDaemon } from './fake-chat-agent'

const STAGE: ChatStage = { conversationId: 'conversation-1', stageId: 'stage-1', agent: 'claude', options: { cwd: '/work/repo', extraDirs: [], resume: null } }

describe('Kando\'s own questions in a chat', () => {
  let root: string
  let daemon: ReturnType<typeof fakeChatDaemon>
  let published: ChatItem[]
  let activity = 0
  const sink: ChatSink = {
    items: (_conversationId, items) => published.push(...items),
    delta: () => {},
    messages: () => {},
    provider: () => {},
    activity: () => { activity++ },
    offset: () => {},
    usage: () => {}
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-ask-'))
    mkdirSync(path.join(root, 'attachments'))
    daemon = fakeChatDaemon()
    published = []
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function started(): Promise<{ host: ChatHost; sessionId: string }> {
    const host = new ChatHost(daemon, root, new AttachmentStore(path.join(root, 'attachments')), sink)
    daemon.deliver = (event) => {
      if (event.event === 'data') host.handleData(event.sessionId, event.offset, event.data)
      if (event.event === 'exit') host.handleExit(event.sessionId, event.exitCode)
    }
    const { sessionId } = await daemon.request('spawnPipe', { command: 'claude', args: [], cwd: '/work/repo', env: {} })
    await host.open(STAGE, sessionId, 0, true)
    return { host, sessionId }
  }

  it('shows the question as a pending approval, publishes the answer, and survives a replay', async () => {
    const { host, sessionId } = await started()
    const before = activity
    const requestId = host.ask(STAGE.conversationId, { kind: 'browser-host', host: 'example.com', url: 'https://example.com/' })
    expect(requestId).toMatch(/^kando:browser-host:/)
    expect(published.at(-1)).toMatchObject({ kind: 'approval', requestId, tool: 'browser_host', title: 'example.com', resolution: null })
    expect(host.activity(STAGE.conversationId)).toBe('awaiting')
    expect(activity).toBeGreaterThan(before)
    host.answer(STAGE.conversationId, requestId, 'allowedForSession', 'go ahead')
    expect(published.at(-1)).toMatchObject({ kind: 'approval', requestId, resolution: 'allowedForSession' })
    expect(host.activity(STAGE.conversationId)).toBe('idle')
    // Nothing was written to the agent: the question was Kando's.
    expect(daemon.written(sessionId).filter((frame) => JSON.stringify(frame).includes(requestId))).toEqual([])

    const open = host.ask(STAGE.conversationId, { kind: 'browser-host', host: 'other.com', url: 'https://other.com/' })
    daemon.exit(sessionId, 0)
    const replayed = host.items(STAGE).filter((item) => item.kind === 'approval')
    expect(replayed.map((item) => item.kind === 'approval' && [item.requestId, item.resolution])).toEqual([[requestId, 'allowedForSession'], [open, 'cancelled']])
  })

  it('withdraws the questions a stage was replayed with', async () => {
    const { host } = await started()
    const requestId = host.ask(STAGE.conversationId, { kind: 'browser-host', host: 'example.com', url: 'https://example.com/' })
    host.cancelAsks(STAGE.conversationId)
    expect(published.at(-1)).toMatchObject({ requestId, resolution: 'cancelled' })
    expect(host.activity(STAGE.conversationId)).toBe('idle')
  })
})
