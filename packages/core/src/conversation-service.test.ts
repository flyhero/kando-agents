import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentKind } from '@kando/protocol'
import type { DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

type Handlers = { [M in DaemonMethod]: (params: DaemonParams<M>) => DaemonResult<M> }

function fakeDaemon(): SessionHost & { spawns: DaemonParams<'spawn'>[]; killed: string[]; output: Map<string, string>; failNextSpawn: boolean } {
  const spawns: DaemonParams<'spawn'>[] = []
  const killed: string[] = []
  const output = new Map<string, string>()
  const handlers: Handlers = {
    spawn: (params) => {
      spawns.push(params)
      const sessionId = `session-${spawns.length}`
      output.set(sessionId, '')
      return { sessionId }
    },
    write: () => ({ ok: true }),
    resize: () => ({ ok: true }),
    kill: ({ sessionId }) => { killed.push(sessionId); return { ok: true } },
    attach: ({ sessionId }) => {
      const buffer = output.get(sessionId) ?? ''
      return { sessionId, buffer, bufferStart: 0, endOffset: buffer.length, exited: false, exitCode: null }
    },
    list: () => ({ sessions: [] })
  }
  const daemon: SessionHost & { spawns: DaemonParams<'spawn'>[]; killed: string[]; output: Map<string, string>; failNextSpawn: boolean } = {
    spawns, killed, output, failNextSpawn: false,
    request: async (method, params) => {
      if (method === 'spawn' && daemon.failNextSpawn) {
        daemon.failNextSpawn = false
        throw new Error('spawn failed')
      }
      return handlers[method](params)
    },
    onEvent: () => () => {}
  }
  return daemon
}

describe('ConversationService', () => {
  let root: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeDaemon>
  let service: ConversationService

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-conversation-'))
    const database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeDaemon()
    service = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent], () => {}, projects)
  })

  afterEach(() => {
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  function event(id: string, stageId: string, agent: AgentKind, role: 'user' | 'assistant', text: string, key: string, complete = true) {
    service.recordEvent({ id, stageId, agent, role, text, eventKey: key, complete, providerSessionId: null })
  }

  it('starts in a persistent isolated workspace and restores its native conversation', async () => {
    const created = await service.create('claude', [])
    expect(created.workspacePath).toBe(path.join(root, 'sessions', created.id, 'workspace'))
    expect(daemon.spawns[0]).toMatchObject({ command: 'claude', cwd: created.workspacePath })
    const providerId = service.stages(created.id)[0]?.providerSessionId
    expect(daemon.spawns[0]?.args).toContain('--session-id')
    await expect(service.continue(created.id)).rejects.toThrow('conversation-running')
    event(created.id, service.stages(created.id)[0]!.id, 'claude', 'user', 'Hello', 'user-1')
    await service.stop(created.id)
    await service.continue(created.id)
    expect(daemon.spawns[1]?.args).toEqual(expect.arrayContaining(['--resume', providerId]))
  })

  it('uses the first of multiple projects as cwd and grants every extra directory to both agents', async () => {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    const created = await service.create('claude', [first, second])
    expect(created.projectPaths).toEqual([realpathSync(first), realpathSync(second)])
    expect(daemon.spawns[0]).toMatchObject({ cwd: realpathSync(first) })
    expect(daemon.spawns[0]?.args).toEqual(expect.arrayContaining(['--add-dir', realpathSync(second)]))
    expect(existsSync(path.join(root, 'sessions', created.id, 'workspace'))).toBe(false)
    await service.stop(created.id)
    await service.handoff(created.id, 'codex', '', false)
    expect(daemon.spawns[1]).toMatchObject({ cwd: realpathSync(first) })
    expect(daemon.spawns[1]?.args).toEqual(expect.arrayContaining(['--add-dir', realpathSync(second)]))
    await expect(service.create('codex', [first, first])).rejects.toThrow('duplicate-project')
  })

  it('adds its projects to the recent list tasks pick from, but not the managed workspace', async () => {
    const project = path.join(root, 'project')
    mkdirSync(project)
    await service.create('codex', [])
    expect(projects.recent()).toEqual([])
    await service.create('codex', [project])
    expect(projects.recent()).toEqual([project])
  })

  it('records messages once, locks manual titles and passes only unseen messages on return handoff', async () => {
    const created = await service.create('claude', [root])
    const firstStage = service.stages(created.id)[0]!
    event(created.id, firstStage.id, 'claude', 'user', '  Build an API  \n more', 'user-1', false)
    event(created.id, firstStage.id, 'claude', 'user', '  Build an API  \n more', 'user-1', false)
    expect(service.get(created.id).title).toBe('Build an API')
    event(created.id, firstStage.id, 'claude', 'assistant', 'Done', 'assistant-1')
    expect(service.messages(created.id)).toHaveLength(2)
    expect(service.messages(created.id)[0]?.complete).toBe(true)
    service.rename(created.id, 'Custom')
    await service.stop(created.id)
    await service.handoff(created.id, 'codex', 'Please review', false)
    expect(service.list()).toHaveLength(1)
    expect(daemon.spawns[1]?.cwd).toBe(realpathSync(root))
    const handoffPath = daemon.spawns[1]?.args.at(-1)
    expect(handoffPath).toContain('Kando 移交文件')
    const handoffDir = path.join(root, 'sessions', created.id, 'handoffs')
    const files = await import('node:fs/promises').then((fs) => fs.readdir(handoffDir))
    const initial = readFileSync(path.join(handoffDir, files[0]!), 'utf8')
    expect(initial).toContain('Build an API')
    expect(initial).toContain('Please review')
    const codexStage = service.stages(created.id)[1]!
    service.recordEvent({ id: created.id, stageId: codexStage.id, agent: 'codex', role: 'user', text: 'Verify tests', eventKey: 'turn:0', complete: true, providerSessionId: 'thread-1' })
    event(created.id, codexStage.id, 'codex', 'assistant', 'Tests pass', 'turn:1')
    await service.stop(created.id)
    await service.handoff(created.id, 'claude', '', false)
    const secondFiles = await import('node:fs/promises').then((fs) => fs.readdir(handoffDir))
    const delta = readFileSync(path.join(handoffDir, secondFiles.find((file) => file !== files[0])!), 'utf8')
    expect(delta).toContain('Verify tests')
    expect(delta).not.toContain('Build an API')
    expect(daemon.spawns[2]?.args).toEqual(expect.arrayContaining(['--resume', firstStage.providerSessionId]))
    expect(service.get(created.id).title).toBe('Custom')
    expect(() => event(created.id, firstStage.id, 'codex', 'user', 'Wrong agent', 'wrong')).toThrow('conversation-event-invalid')
  })

  it('starts Claude afresh, with the whole conversation, when the session id it picked was never saved', async () => {
    const created = await service.create('codex', [root])
    event(created.id, service.stages(created.id)[0]!.id, 'codex', 'user', 'Fix the build', 'user-1')
    await service.handoff(created.id, 'claude', '', true)
    const unsaved = service.stages(created.id)[1]!.providerSessionId
    service.handleExit(service.get(created.id).sessionId ?? '', 1)
    await service.handoff(created.id, 'codex', '', false)
    await service.handoff(created.id, 'claude', '', true)
    const args = daemon.spawns.at(-1)?.args ?? []
    expect(args).not.toContain('--resume')
    expect(args[args.indexOf('--session-id') + 1]).not.toBe(unsaved)
    const handoffFile = args.at(-1)?.match(/移交文件 (\S+)，/)?.[1] ?? ''
    expect(readFileSync(handoffFile, 'utf8')).toContain('Fix the build')
  })

  it('reports how the agent last stopped: exited, stopped, or never ended', async () => {
    const created = await service.create('claude', [root])
    expect(created.lastExit).toBeNull()
    service.handleExit(created.sessionId ?? '', 0)
    expect(service.get(created.id).lastExit).toMatchObject({ code: 0 })
    const resumed = await service.continue(created.id)
    expect(resumed.lastExit).toMatchObject({ code: 0 })
    service.handleExit(resumed.sessionId ?? '', 1)
    expect(service.get(created.id).lastExit).toMatchObject({ code: 1 })
    await service.continue(created.id)
    expect((await service.stop(created.id)).lastExit).toMatchObject({ code: null })
  })

  it('finds conversations by message text, once each, with the latest match', async () => {
    const first = await service.create('claude', [root])
    const second = await service.create('codex', [root])
    const stage = (id: string) => service.stages(id)[0]!.id
    event(first.id, stage(first.id), 'claude', 'user', 'Fix the Login redirect', 'user-1')
    event(first.id, stage(first.id), 'claude', 'assistant', 'The login page now redirects home', 'assistant-1')
    event(second.id, stage(second.id), 'codex', 'user', '整理这周的周报', 'user-1')
    expect(service.search('LOGIN')).toEqual([{ conversationId: first.id, snippet: 'The login page now redirects home' }])
    expect(service.search('周报')).toEqual([{ conversationId: second.id, snippet: '整理这周的周报' }])
    expect(service.search('nothing like it')).toEqual([])
  })

  it('recovers daemon output once and preserves workspaces on deletion', async () => {
    const created = await service.create('codex', [])
    const sessionId = created.sessionId!
    service.handleData({ event: 'data', sessionId, offset: 0, data: 'abc' })
    daemon.output.set(sessionId, 'abcdef')
    await service.reconcile([{ sessionId, exited: false, exitCode: null }])
    service.handleData({ event: 'data', sessionId, offset: 3, data: 'def' })
    let offset = 0
    let transcript = ''
    for (;;) {
      const chunk = service.history(created.id, offset, 2)
      transcript += Buffer.from(chunk.data, 'base64').toString('utf8')
      if (chunk.nextOffset >= chunk.totalBytes) break
      offset = chunk.nextOffset
    }
    expect(transcript).toContain('abcdef')
    expect(transcript).not.toContain('abcdefdef')
    await service.delete(created.id)
    expect(existsSync(created.workspacePath)).toBe(true)
    expect(existsSync(path.join(root, 'sessions', created.id, 'terminal.log'))).toBe(false)
    expect(service.list()).toEqual([])
  })

  it('does not advance provider history or keep a phantom stage when handoff spawn fails', async () => {
    const created = await service.create('claude', [])
    const original = service.stages(created.id)[0]!
    event(created.id, original.id, 'claude', 'user', 'Hello', 'user-1')
    await service.stop(created.id)
    daemon.failNextSpawn = true
    await expect(service.handoff(created.id, 'codex', 'Try again', false)).rejects.toThrow('spawn failed')
    expect(service.get(created.id).agent).toBe('claude')
    expect(service.stages(created.id)).toHaveLength(1)
    expect(service.stages(created.id)[0]?.providerSessionId).toBe(original.providerSessionId)
    await service.continue(created.id)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', original.providerSessionId]))
  })
})
