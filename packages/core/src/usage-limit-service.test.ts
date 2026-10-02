import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentUsage, ChatItem, TaskStatus } from '@kando/protocol'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'
import { CONTINUE_TEXT, UsageLimitService } from './usage-limit-service'

const HOUR = 3_600_000

describe('UsageLimitService', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let limits: UsageLimitService
  let clock: number
  let usage: AgentUsage[]
  let emitted: ChatItem[]
  let taskStatus: TaskStatus | null
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  function serve(): void {
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent],
      (event) => { if (event.type === 'chatItems') limits.observe(event.conversationId, event.items) },
      projects, attachments())
    const target = conversations
    daemon.deliver = (event) => {
      if (event.event === 'data') target.handleData(event)
      else if (event.event === 'exit') target.handleExit(event.sessionId, event.exitCode)
      else target.handleStderr(event.sessionId, event.data)
    }
    limits = new UsageLimitService(database, {
      conversations,
      resumeTask: async () => {},
      taskStatus: () => taskStatus,
      usage: { list: () => usage, refresh: async () => usage },
      emit: (_conversationId, items) => emitted.push(...items)
    }, () => clock)
  }

  function attachments(): AttachmentStore {
    const dir = path.join(root, 'attachments')
    mkdirSync(dir, { recursive: true })
    return new AttachmentStore(dir)
  }

  // The first message Claude Code gets runs into the five-hour limit; later ones go through.
  function limitFirstTurn(resetsAt: number): void {
    const answer = daemon.reply
    let first = true
    daemon.reply = (sessionId, text) => {
      if (!first) return answer(sessionId, text)
      first = false
      daemon.emit(sessionId, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAt / 1000 } })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 8pm", duration_ms: 20 })
    }
  }

  async function limitedChat(resetsAt = clock + HOUR) {
    limitFirstTurn(resetsAt)
    const conversation = await conversations.create('claude', [], 'chat')
    await conversations.send(conversation.id, 'refactor the payments module')
    await settle()
    const item = conversations.chatPage(conversation.id).items.find((each) => each.kind === 'usageLimit')
    if (!item) throw new Error('no usage limit item')
    return { id: conversation.id, item }
  }

  const userTexts = (id: string) => conversations.chatPage(id).items.flatMap((item) => (item.kind === 'user' ? [item.text] : []))
  const statusOf = (item: ChatItem) => {
    const [decorated] = limits.decorate([item])
    return decorated?.kind === 'usageLimit' ? decorated : null
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-usage-limit-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    clock = Date.now()
    usage = []
    emitted = []
    taskStatus = null
    serve()
  })

  afterEach(() => {
    limits.stop()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('waits for the limit to lift, then continues the chat once with a message from the user\'s side', async () => {
    const resetsAt = clock + HOUR
    const { id, item } = await limitedChat(resetsAt)
    expect(statusOf(item)).toMatchObject({ status: 'waiting', autoContinue: true, resetsAt, continueAt: resetsAt + 5_000 })

    await limits.tick()
    expect(userTexts(id)).toEqual(['refactor the payments module'])

    clock = resetsAt + 5_000
    await limits.tick()
    await settle()
    expect(userTexts(id)).toEqual(['refactor the payments module', CONTINUE_TEXT])
    expect(statusOf(item)).toMatchObject({ status: 'continued', continuedAt: clock, continueAt: null })
    expect(emitted.at(-1)).toMatchObject({ kind: 'usageLimit', status: 'continued' })

    clock += HOUR
    await limits.tick()
    expect(userTexts(id)).toHaveLength(2)
  })

  it('goes on in a new stage when the agent was released meanwhile, resuming its session', async () => {
    const { id, item } = await limitedChat()
    await conversations.releaseIdle(Date.now() + 31 * 60_000)
    expect(conversations.get(id).sessionId).toBeNull()
    clock += 2 * HOUR
    await limits.tick()
    await settle()
    expect(conversations.get(id).sessionId).not.toBeNull()
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume']))
    expect(userTexts(id).at(-1)).toBe(CONTINUE_TEXT)
    expect(statusOf(item)?.status).toBe('continued')
  })

  it('waits on when core\'s fresh reading says the limit has not lifted after all', async () => {
    const { id, item } = await limitedChat()
    const later = clock + 3 * HOUR
    usage = [{ agent: 'claude', status: 'ok', plan: null, error: null, updatedAt: clock, resetCredits: null,
      windows: [{ kind: 'session', model: null, usedPercent: 100, windowMinutes: 300, resetsAt: later }] }]
    clock += 2 * HOUR
    await limits.tick()
    expect(userTexts(id)).toHaveLength(1)
    expect(statusOf(item)).toMatchObject({ status: 'waiting', resetsAt: later, continueAt: later + 5_000 })
  })

  it('learns when a limit lifts from core\'s reading when the agent does not say', async () => {
    usage = [{ agent: 'claude', status: 'ok', plan: null, error: null, updatedAt: clock, resetCredits: null,
      windows: [{ kind: 'session', model: null, usedPercent: 100, windowMinutes: 300, resetsAt: clock + HOUR }] }]
    const answer = daemon.reply
    let first = true
    daemon.reply = (sessionId, text) => {
      if (!first) return answer(sessionId, text)
      first = false
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", duration_ms: 20 })
    }
    const conversation = await conversations.create('claude', [], 'chat')
    await conversations.send(conversation.id, 'go')
    await settle()
    const item = conversations.chatPage(conversation.id).items.find((each) => each.kind === 'usageLimit')
    expect(item && statusOf(item)).toMatchObject({ resetsAt: clock + HOUR, continueAt: clock + HOUR + 5_000 })
  })

  it('stays put once the user goes on another way, or turns it off', async () => {
    const first = await limitedChat()
    // A limit the user's own message ran into, while it was being sent, stays.
    limits.cancelFor(first.id, clock - 1)
    expect(statusOf(first.item)?.status).toBe('waiting')
    limits.cancelFor(first.id, clock + 1)
    clock += 2 * HOUR
    await limits.tick()
    expect(userTexts(first.id)).toHaveLength(1)
    expect(statusOf(first.item)?.status).toBe('cancelled')
    expect(() => limits.setAutoContinue(first.id, first.item.stageId, first.item.id, true)).toThrow(expect.objectContaining({ reason: 'usage-limit-settled' }))

    // Items carry the real time: one seen hours "later" by the clock above would count as replayed.
    clock = Date.now()
    const second = await limitedChat(clock + HOUR)
    limits.setAutoContinue(second.id, second.item.stageId, second.item.id, false)
    clock += 2 * HOUR
    await limits.tick()
    expect(userTexts(second.id)).toHaveLength(1)
    expect(statusOf(second.item)).toMatchObject({ status: 'waiting', autoContinue: false, continueAt: null })
  })

  it('lets one retry through at a time, and continues at once without waiting for the reset', async () => {
    const { id, item } = await limitedChat()
    const [first, second] = await Promise.allSettled([
      limits.retry(id, item.stageId, item.id),
      limits.retry(id, item.stageId, item.id)
    ])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ reason: 'usage-limit-busy' }) })
    await settle()
    expect(userTexts(id).filter((text) => text === CONTINUE_TEXT)).toHaveLength(1)
  })

  it('does not send again for a try that went out before core stopped', async () => {
    const { id, item } = await limitedChat()
    const raw = new DatabaseSync(database)
    const row = raw.prepare('SELECT id FROM conversation_usage_limits').get()
    const rowId = typeof row?.id === 'string' ? row.id : ''
    await conversations.send(id, CONTINUE_TEXT, [], false, false, `usage-limit:${rowId}`)
    raw.prepare("UPDATE conversation_usage_limits SET status = 'retrying'").run()
    raw.close()
    limits.stop()
    serve()
    limits.start()
    expect(statusOf(item)?.status).toBe('continued')
    expect(userTexts(id).filter((text) => text === CONTINUE_TEXT)).toHaveLength(1)
  })

  it('only shows a limit a replayed log brings back from before it was seen', async () => {
    const { id, item } = await limitedChat()
    const old = { ...item, stageId: item.stageId, id: 'limit:old', at: clock - HOUR }
    limits.observe(id, [old])
    expect(statusOf(old)).toMatchObject({ status: 'cancelled', autoContinue: false })
    // Never planned for: shown as settled.
    expect(statusOf({ ...item, id: 'limit:unknown' })).toMatchObject({ status: 'cancelled', autoContinue: false, continueAt: null })
  })

  it('drops the plan of a task chat whose task is no longer worked on', async () => {
    const { id, item } = await limitedChat()
    limits.taskChanged({ status: 'review', conversationId: id })
    expect(statusOf(item)?.status).toBe('cancelled')
  })
})
