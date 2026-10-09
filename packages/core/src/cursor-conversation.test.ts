import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'
import { requireCursorCli } from './cursor-cli'
import { writePrivateJson } from './private-file'

vi.mock('./cursor-cli', () => ({ requireCursorCli: vi.fn(async () => '/fake/cursor-agent'), cursorCatalog: vi.fn(async () => null) }))
const Frame = z.looseObject({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const modes = { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] }
let root: string
let tasks: TaskStore
let store: ConversationStore
let projects: ProjectRegistry
let service: ConversationService
let daemon: ReturnType<typeof fakeChatDaemon>
let answerPrompt: boolean
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'kando-cursor-conversation-'))
  const database = path.join(root, 'kando.db')
  tasks = new TaskStore(database); store = new ConversationStore(database); projects = new ProjectRegistry(database)
  mkdirSync(path.join(root, 'attachments'))
  answerPrompt = true
  daemon = fakeChatDaemon()
  service = new ConversationService(store, daemon, path.join(root, 'sessions'), () => {}, projects, new AttachmentStore(path.join(root, 'attachments')), (id) => ({ command: 'node', args: ['mcp', '--conversation', id] }))
  daemon.deliver = (event) => {
    if (event.event === 'data') service.handleData(event)
    else if (event.event === 'exit') service.handleExit(event.sessionId, event.exitCode)
    else service.handleStderr(event.sessionId, event.data)
  }
  const request = daemon.request
  daemon.request = async (method, params) => {
    const result = await request(method, params)
    if (method !== 'write') return result
    const write = z.object({ sessionId: z.string(), data: z.string() }).parse(params)
    for (const line of write.data.split('\n').filter(Boolean)) {
      const frame = Frame.parse(JSON.parse(line))
      const reply = (body: unknown) => queueMicrotask(() => daemon.emit(write.sessionId, { id: frame.id, result: body }))
      if (frame.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
      else if (frame.method === 'cursor/list_available_models') reply({ models: [] })
      else if (frame.method === 'session/new' || frame.method === 'session/load') {
        const opened = z.object({ sessionId: z.string().optional(), mcpServers: z.array(z.object({ args: z.array(z.string()) })) }).parse(frame.params)
        const args = opened.mcpServers[0]?.args ?? []
        const ready = args[args.indexOf('--ready-file') + 1]
        if (ready) await writePrivateJson(ready, { ready: true })
        reply({ sessionId: opened.sessionId ?? `cursor-${write.sessionId}`, modes })
      } else if (frame.method === 'session/set_mode') reply({})
      else if (frame.method === 'session/prompt') {
        if (!answerPrompt) continue
        const prompt = z.object({ sessionId: z.string(), prompt: z.array(z.object({ text: z.string() })) }).parse(frame.params)
        queueMicrotask(() => {
          daemon.emit(write.sessionId, { method: 'session/update', params: { sessionId: prompt.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${prompt.prompt[0]?.text}` } } } })
          daemon.emit(write.sessionId, { id: frame.id, result: { stopReason: 'end_turn' } })
        })
      }
    }
    return result
  }
})

afterEach(() => { vi.useRealTimers(); vi.mocked(requireCursorCli).mockReset().mockResolvedValue('/fake/cursor-agent'); projects.close(); store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

it('runs every Cursor turn in a fresh ACP process and restores the native session', async () => {
  const created = await service.create('cursor', [])
  await service.send(created.id, 'first turn'); await settle()
  const providerSessionId = service.stages(created.id).at(-1)?.providerSessionId

  await service.send(created.id, 'second turn'); await settle()

  expect(daemon.spawns).toHaveLength(2)
  expect(daemon.written('pipe-1')).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'session/prompt', params: expect.objectContaining({ prompt: [expect.objectContaining({ text: 'first turn' })] }) })
  ]))
  expect(daemon.written('pipe-2')).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: providerSessionId }) }),
    expect.objectContaining({
      method: 'session/prompt',
      params: expect.objectContaining({ prompt: [expect.objectContaining({ text: 'second turn' })] })
    })
  ]))
  expect(daemon.killed).toContainEqual({ sessionId: 'pipe-1', force: false })
})

it('carries multiple queued messages across their per-turn Cursor processes', async () => {
  answerPrompt = false
  const created = await service.create('cursor', [])
  await service.send(created.id, 'first')
  await service.send(created.id, 'second', [], true)
  await service.send(created.id, 'third', [], true)

  answerPrompt = true
  daemon.emit('pipe-1', { id: 'cursor-prompt-1', result: { stopReason: 'end_turn' } })
  await vi.waitFor(() => expect(daemon.spawns).toHaveLength(3))
  expect(daemon.written('pipe-2')).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'session/prompt', params: expect.objectContaining({ prompt: [expect.objectContaining({ text: 'second' })] }) })
  ]))
  expect(daemon.written('pipe-3')).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'session/prompt', params: expect.objectContaining({ prompt: [expect.objectContaining({ text: 'third' })] }) })
  ]))
})

it('stops a silent Cursor turn and retries it only after the user asks', async () => {
  vi.useFakeTimers()
  answerPrompt = false
  const created = await service.create('cursor', [])
  await service.send(created.id, 'do this once')

  await vi.advanceTimersByTimeAsync(30_000)
  const notice = service.chatPage(created.id).items.find((item) => item.kind === 'notice' && item.action?.kind === 'retryCursorTurn')
  expect(notice).toMatchObject({
    kind: 'notice',
    level: 'warning',
    action: { kind: 'retryCursorTurn' }
  })
  expect(daemon.written('pipe-1')).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/cancel' })]))
  expect(daemon.spawns).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(2_000)
  expect(daemon.killed).toContainEqual({ sessionId: 'pipe-1', force: false })

  answerPrompt = true
  await service.retryCursorTurn(created.id, notice!.stageId, notice!.id)
  await vi.runAllTimersAsync()
  expect(daemon.spawns).toHaveLength(2)
  expect(daemon.written('pipe-2')).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'session/load' }),
    expect.objectContaining({
      method: 'session/prompt',
      params: expect.objectContaining({ prompt: [expect.objectContaining({ text: 'do this once' })] })
    })
  ]))
  expect(service.chatItem(created.id, notice!.stageId, notice!.id)).toMatchObject({ action: null })
})

it('cancels a user-stopped Cursor turn before terminating its process', async () => {
  vi.useFakeTimers()
  answerPrompt = false
  daemon.exitOnKill = false
  const created = await service.create('cursor', [])
  await service.send(created.id, 'keep working')

  const interrupted = service.interrupt(created.id)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(daemon.written('pipe-1')).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/cancel' })]))
  expect(daemon.killed).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(daemon.killed).toEqual([{ sessionId: 'pipe-1', force: false }])
  await vi.advanceTimersByTimeAsync(1_999)
  expect(daemon.killed).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(daemon.killed).toContainEqual({ sessionId: 'pipe-1', force: true })
  daemon.exit('pipe-1', 137)
  await interrupted
})

it('uses conversation-bound MCP on new and load, preserves native resume and forks with visible history into a new session', async () => {
  const created = await service.create('cursor', [])
  expect(daemon.spawns[0]).toMatchObject({ command: '/fake/cursor-agent', args: ['acp'], cwd: created.workspacePath })
  await service.send(created.id, 'remember this visible message'); await settle()
  const stage = service.stages(created.id).at(-1)!
  const assistant = service.chatPage(created.id).items.find((item) => item.kind === 'assistant')!
  await service.stop(created.id); await service.continue(created.id)
  expect(service.stages(created.id).at(-1)?.providerSessionId).toBe(stage.providerSessionId)
  expect(daemon.written('pipe-2')).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/load', params: expect.objectContaining({ sessionId: stage.providerSessionId }) })]))
  const forked = await service.fork(created.id, stage.id, assistant.id); await settle()
  expect(service.stages(forked.id).at(-1)?.providerSessionId).not.toBe(stage.providerSessionId)
  const frames = daemon.written(forked.sessionId!)
  expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'session/new' })]))
  expect(frames.some((frame) => JSON.stringify(frame).includes('session/load'))).toBe(false)
  const prompt = frames.map((frame) => Frame.parse(frame)).find((frame) => frame.method === 'session/prompt')
  const text = z.object({ prompt: z.array(z.object({ text: z.string() })) }).parse(prompt?.params).prompt[0]?.text ?? ''
  const handoff = /移交文件 (.+?)，/.exec(text)?.[1]
  expect(handoff).toBeTruthy()
  expect(readFileSync(handoff!, 'utf8')).toContain('remember this visible message')
  expect(JSON.stringify(frames)).toContain(forked.id)
})

it('removes a never-started stage when Cursor preflight fails', async () => {
  vi.mocked(requireCursorCli).mockRejectedValueOnce(new Error('login required'))
  await expect(service.create('cursor', [])).rejects.toThrow('login required')
  const conversation = store.list()[0]!
  expect(store.stages(conversation.id)).toEqual([])
  expect(conversation.sessionId).toBeNull()
  expect(daemon.spawns).toEqual([])
})
