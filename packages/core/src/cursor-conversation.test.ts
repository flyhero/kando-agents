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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'kando-cursor-conversation-'))
  const database = path.join(root, 'kando.db')
  tasks = new TaskStore(database); store = new ConversationStore(database); projects = new ProjectRegistry(database)
  mkdirSync(path.join(root, 'attachments'))
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

afterEach(() => { vi.mocked(requireCursorCli).mockReset().mockResolvedValue('/fake/cursor-agent'); projects.close(); store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

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
