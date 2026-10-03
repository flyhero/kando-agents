import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentStore } from './attachment-store'
import { ChatTurnStore, summarizeTurns } from './chat-turn-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

describe('ChatTurnStore', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let turns: ChatTurnStore
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-turns-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    const attachments = path.join(root, 'attachments')
    mkdirSync(attachments, { recursive: true })
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'),
      // Wired as main.ts wires it: every batch a live stage puts out.
      (event) => { if (event.type === 'chatItems') turns.observe(event.conversationId, event.items) },
      projects, new AttachmentStore(attachments))
    const target = conversations
    daemon.deliver = (event) => {
      if (event.event === 'data') target.handleData(event)
      else if (event.event === 'exit') target.handleExit(event.sessionId, event.exitCode)
    }
    turns = new ChatTurnStore(database, {
      facts: (id, stageId) => conversations.stageFacts(id, stageId),
      stages: () => conversations.chatStageRefs(),
      items: (id, stageId) => conversations.stageChatItems(id, stageId)
    })
    // Each turn reads and writes the same, and takes a little longer than the last.
    let calls = 0
    daemon.reply = (sessionId, text) => {
      calls++
      daemon.emit(sessionId, { type: 'assistant', message: { id: `msg-${calls}`, content: [{ type: 'text', text: `echo: ${text}` }] }, parent_tool_use_id: null })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: false, result: 'ok', terminal_reason: 'completed', duration_ms: calls * 1000,
        usage: { input_tokens: 100, output_tokens: 20 } })
    }
  })

  afterEach(() => {
    turns.close()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function chat(...messages: string[]): Promise<string> {
    const conversation = await conversations.create('claude', [])
    for (const message of messages) {
      await conversations.send(conversation.id, message)
      await settle()
    }
    return conversation.id
  }

  it('counts each turn of a free conversation as it ends, under its agent and model', async () => {
    await chat('one', 'two', 'three')
    const [stats, ...rest] = turns.stats()
    expect(rest).toEqual([])
    expect(stats).toEqual({
      agent: 'claude', model: expect.any(String), conversations: 1, turns: 3, failed: 0, interrupted: 0, usageLimits: 0,
      medianTurnMs: 2000, medianTurnTokens: 120, totalTokens: 360
    })
  })

  it('counts a turn the usage limit stopped as failed, and as a limit', async () => {
    const answer = daemon.reply
    daemon.reply = (sessionId) => {
      daemon.emit(sessionId, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", duration_ms: 10 })
      daemon.reply = answer
    }
    await chat('stopped', 'goes on')
    expect(turns.stats()[0]).toMatchObject({ turns: 2, failed: 1, usageLimits: 1 })
  })

  it('counts a turn once however often its stage puts it out again', async () => {
    const id = await chat('one', 'two')
    turns.observe(id, conversations.chatPage(id).items)
    turns.observe(id, conversations.chatPage(id).items)
    expect(turns.stats()[0]).toMatchObject({ turns: 2, totalTokens: 240 })
  })

  it('leaves a task\'s chat out, which its task\'s runs account for', async () => {
    const conversation = await conversations.startForTask({ id: 'task-1', title: 'Task chat', agent: 'claude' }, { cwd: root, extraDirs: [], planOnly: false, session: 'new' })
    await conversations.send(conversation.id, 'work')
    await settle()
    expect(turns.stats()).toEqual([])
  })

  it('catches up once on stages that ended before turns were kept', async () => {
    const id = await chat('one', 'two')
    await conversations.releaseIdle(Date.now() + 31 * 60_000)
    const raw = new DatabaseSync(database)
    raw.exec('DELETE FROM chat_turns')
    raw.close()
    expect(turns.stats()).toEqual([])

    await turns.catchUp()
    expect(turns.stats()[0]).toMatchObject({ conversations: 1, turns: 2 })
    // Counted stages are not read again, even if their turns were somehow lost since.
    const again = new DatabaseSync(database)
    again.exec('DELETE FROM chat_turns')
    again.close()
    await turns.catchUp()
    expect(turns.stats()).toEqual([])
    expect(conversations.get(id).sessionId).toBeNull()
  })
})

describe('summarizeTurns', () => {
  const row = (fields: Partial<Parameters<typeof summarizeTurns>[0][number]>) => ({
    conversationId: 'c1', agent: 'claude' as const, model: null, state: 'completed', durationMs: 1000, totalTokens: 100, usageLimit: 0, ...fields
  })

  it('keeps each model apart, known models first and busier ones before quieter ones', () => {
    const stats = summarizeTurns([
      row({ agent: 'codex' }),
      row({ model: 'opus' }),
      row({ model: 'sonnet', conversationId: 'c2' }),
      row({ model: 'sonnet', conversationId: 'c3', state: 'interrupted', totalTokens: null }),
      row({})
    ])
    expect(stats.map((each) => [each.agent, each.model, each.conversations, each.turns, each.interrupted, each.totalTokens])).toEqual([
      ['claude', 'sonnet', 2, 2, 1, 100],
      ['claude', 'opus', 1, 1, 0, 100],
      ['claude', null, 1, 1, 0, 100],
      ['codex', null, 1, 1, 0, 100]
    ])
  })
})
