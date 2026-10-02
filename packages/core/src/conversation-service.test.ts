import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentKind } from '@kando/protocol'
import type { DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { pngBytes } from './image-fixtures'
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
    list: () => ({ sessions: [] }),
    spawnPipe: () => { throw new Error('unused') },
    release: () => ({ ok: true }),
    awakeSet: () => ({ active: false, supported: true, problem: null }),
    awakeStatus: () => ({ active: false, supported: true, problem: null })
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

// The store an image a message names is looked up in; made on the way in.
function attachmentsAt(root: string): AttachmentStore {
  const dir = path.join(root, 'attachments')
  mkdirSync(dir, { recursive: true })
  return new AttachmentStore(dir)
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
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent], () => {}, projects, attachmentsAt(root))
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

  it('waits for a terminal agent to stop before switching a branch, which the user then tells it of', async () => {
    const repo = path.join(root, 'app')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const created = await service.create('claude', [repo])
    const [project] = created.projectPaths
    await expect(service.createBranch(created.id, project!, 'try')).rejects.toMatchObject({ reason: 'conversation-running' })
    await service.stop(created.id)
    await service.createBranch(created.id, project!, 'try')
    expect(store.switchedBranches(created.id)).toEqual({ [project!]: 'try' })
    // A terminal agent is not told; a chat later is not told of a switch it predates either.
    await service.continue(created.id)
    expect(store.switchedBranches(created.id)).toEqual({})
  })

  it('commits and pushes only a conversation project after its terminal agent stops', async () => {
    const repo = path.join(root, 'app')
    const remote = path.join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Kando Test'])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'kando@example.com'])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    writeFileSync(path.join(repo, 'note.txt'), 'hello\n')
    const created = await service.create('claude', [repo])
    const project = created.projectPaths[0]!

    await expect(service.commitPush(created.id, project, 'feat: add note')).rejects.toMatchObject({ reason: 'conversation-running' })
    await service.stop(created.id)
    await expect(service.commitPush(created.id, root, 'feat: add note')).rejects.toMatchObject({ reason: 'repo-not-found' })
    const result = await service.commitPush(created.id, project, 'feat: add note')

    expect(result).toMatchObject({ branch: 'main', upstream: 'origin/main' })
    expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe('feat: add note')
  })

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

  it('keeps the handoff prompt the agent echoes back out of the messages and the title', async () => {
    const created = await service.create('codex', [root])
    await service.handoff(created.id, 'claude', '', true)
    const stage = service.stages(created.id).at(-1)!
    event(created.id, stage.id, 'claude', 'user', daemon.spawns.at(-1)?.args.at(-1) ?? '', 'user-1')
    expect(service.messages(created.id)).toEqual([])
    expect(service.get(created.id).title).toBe('新会话')
    event(created.id, stage.id, 'claude', 'user', 'Fix the build', 'user-2')
    expect(service.get(created.id).title).toBe('Fix the build')
  })

  it('remembers where each project stood when the conversation started, and diffs only its projects', async () => {
    const repo = path.join(root, 'app')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    git('commit', '-q', '--allow-empty', '-m', 'before')
    const created = await service.create('claude', [repo])
    git('commit', '-q', '--allow-empty', '-m', 'during')
    writeFileSync(path.join(repo, 'notes.md'), 'draft\n')
    const [changes] = await service.changes(created.id)
    expect(changes?.commits?.map((commit) => commit.subject)).toEqual(['during'])
    expect(changes?.files.map((file) => file.path)).toEqual(['notes.md'])
    expect((await service.diff(created.id, created.projectPaths[0] ?? '', 'notes.md')).diff).toContain('+draft')
    await expect(service.diff(created.id, root, 'notes.md')).rejects.toMatchObject({ reason: 'repo-not-found' })
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

  it('keeps a task\'s conversation out of the free list and their search', async () => {
    const free = await service.create('claude', [root])
    const task = tasks.create('Chat me')
    const own = store.create('claude', root, [root], undefined, {}, { id: task.id, title: task.title })
    const ownStage = store.startStage(own.id, 'claude', null, 0, undefined, 'chat')
    event(free.id, service.stages(free.id)[0]!.id, 'claude', 'user', 'Fix the login page', 'user-1')
    event(own.id, ownStage.id, 'claude', 'user', 'Fix the login form', 'user-1')
    expect(service.list().map((conversation) => conversation.id)).toEqual([free.id])
    expect(service.search('login').map((hit) => hit.conversationId)).toEqual([free.id])
    expect(service.get(own.id).taskId).toBe(task.id)
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

describe('ConversationService in chat mode', () => {
  let root: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let service: ConversationService

  function serve(): ConversationService {
    const next = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent], () => {}, projects, attachmentsAt(root))
    daemon.deliver = (event) => {
      if (event.event === 'data') next.handleData(event)
      else if (event.event === 'exit') next.handleExit(event.sessionId, event.exitCode)
      else next.handleStderr(event.sessionId, event.data)
    }
    return next
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-conversation-'))
    const database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    service = serve()
  })

  afterEach(() => {
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('runs Claude over stream-json and keeps its messages like a terminal stage would', async () => {
    const announced: unknown[] = []
    service = new ConversationService(store, daemon, path.join(root, 'sessions'),
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent],
      (event) => { if (event.type === 'changed') announced.push(event.conversation.chat) }, projects, attachmentsAt(root))
    const next = service
    daemon.deliver = (event) => {
      if (event.event === 'data') next.handleData(event)
      else if (event.event === 'exit') next.handleExit(event.sessionId, event.exitCode)
    }
    const created = await service.create('claude', [], 'chat')
    // Clients hear that the agent is ready, not only that the conversation exists.
    expect(announced.at(-1)).toEqual({ turn: 'idle' })
    expect(created).toMatchObject({ mode: 'chat', chat: { turn: 'idle' } })
    const args = daemon.spawns[0]?.args ?? []
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session-id']))
    expect(args).not.toContain('--settings')
    expect(service.isChatSession(created.sessionId!)).toBe(true)

    await service.send(created.id, 'Refactor the parser')
    await settle()
    expect(service.messages(created.id).map((message) => [message.role, message.text]))
      .toEqual([['user', 'Refactor the parser'], ['assistant', 'echo: Refactor the parser']])
    expect(service.get(created.id).title).toBe('Refactor the parser')
    expect(service.chatPage(created.id).items.map((item) => item.kind).filter((kind) => kind !== 'state')).toEqual(['user', 'assistant', 'turn'])
    // The JSON never lands in the terminal record.
    const terminal = Buffer.from(service.history(created.id, 0, 65536).data, 'base64').toString()
    expect(terminal).toContain('聊天界面')
    expect(terminal).not.toContain('echo:')
  })

  it('continues a terminal stage in chat mode on the same Claude session, and back again', async () => {
    const created = await service.create('claude', [])
    const [tui] = service.stages(created.id)
    service.recordEvent({ id: created.id, stageId: tui!.id, agent: 'claude', role: 'user', text: 'Hello', eventKey: 'user-1', complete: true, providerSessionId: null })
    await service.stop(created.id)
    await service.continue(created.id, 'chat')
    expect(daemon.spawns[0]?.args).toEqual(expect.arrayContaining(['--resume', tui!.providerSessionId]))
    expect(service.get(created.id).mode).toBe('chat')
    await service.send(created.id, 'Next step')
    await settle()
    await service.stop(created.id)
    expect(service.get(created.id)).toMatchObject({ sessionId: null, lastExit: { code: null } })
    await service.continue(created.id, 'tui')
    expect(daemon.ptySpawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', tui!.providerSessionId]))
  })

  it('stops a chat agent only once it has exited, forcing it when it will not go', async () => {
    const created = await service.create('claude', [], 'chat')
    const sessionId = created.sessionId!
    await service.stop(created.id)
    expect(daemon.killed).toEqual([{ sessionId, force: false }])
    expect(daemon.released).toContain(sessionId)
    expect(service.get(created.id).sessionId).toBeNull()
  })

  it('hands off into chat mode with the handoff prompt as the first message, kept out of the title', async () => {
    const created = await service.create('codex', [])
    await service.stop(created.id)
    await service.handoff(created.id, 'claude', 'watch the tests', false, 'chat')
    const [first] = daemon.written('pipe-1').filter((frame) => JSON.stringify(frame).includes('"type":"user"'))
    expect(JSON.stringify(first)).toContain('请先阅读 Kando 移交文件')
    await settle()
    expect(service.get(created.id).title).toBe('新会话')
  })

  it('runs Codex through app-server and binds the thread it opens', async () => {
    // Codex answers like app-server: the handshake, a thread, and each turn.
    daemon.answerInit = false
    daemon.reply = () => {}
    const creating = service.create('codex', [], 'chat')
    while (!daemon.sessions.get('pipe-1')) await settle()
    const answer = (id: unknown, result: unknown) => daemon.emit('pipe-1', { id, result })
    while (!daemon.written('pipe-1').length) await settle()
    answer('kando-init', {})
    while (!daemon.written('pipe-1').some((frame) => JSON.stringify(frame).includes('thread/start'))) await settle()
    answer('kando-thread', { thread: { id: 'thread-1' } })
    const created = await creating
    expect(daemon.spawns[0]).toMatchObject({ command: 'codex', args: ['app-server'] })
    expect(daemon.written('pipe-1').find((frame) => JSON.stringify(frame).includes('thread/start')))
      .toMatchObject({ params: { approvalPolicy: 'on-request', sandbox: 'workspace-write' } })
    expect(service.stages(created.id)[0]?.providerSessionId).toBe('thread-1')
  })

  it('drops a chat stage that fails to start, leaving nothing to resume', async () => {
    daemon.answerInit = false
    daemon.reply = () => {}
    const creating = service.create('claude', [], 'chat')
    while (!daemon.sessions.get('pipe-1')) await settle()
    daemon.sessions.get('pipe-1')!.stderr = 'Not logged in'
    daemon.exit('pipe-1', 1)
    await expect(creating).rejects.toMatchObject({ reason: 'chat-start-failed' })
    const [conversation] = service.list()
    expect(service.stages(conversation!.id)).toEqual([])
    expect(conversation?.sessionId).toBeNull()
  })

  it('remembers a switched option for the next start, and bypass only when allowed', async () => {
    const created = await service.create('claude', [], 'chat')
    await service.setOption(created.id, 'permissionMode', 'plan')
    expect(daemon.written(created.sessionId!).at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'plan' } })
    await expect(service.setOption(created.id, 'permissionMode', 'bypass')).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await service.stop(created.id)
    await service.continue(created.id, 'chat', true)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--allow-dangerously-skip-permissions']))
  })

  it('remembers the mode the stage was left in, as approving a plan leaves it', async () => {
    const created = await service.create('claude', [], 'chat')
    await service.setOption(created.id, 'permissionMode', 'plan')
    await settle()
    // Carrying out the plan with edits accepted: Claude reports the switch itself.
    daemon.emit(created.sessionId!, { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })
    await settle()
    await service.stop(created.id)
    await service.continue(created.id, 'chat')
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
  })

  it('starts a new chat in the permission mode picked for it, one the agent has', async () => {
    const created = await service.create('claude', [], 'chat', false, { permissionMode: 'plan' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(service.get(created.id).chatOptions?.permissionMode).toBe('plan')
    await expect(service.create('claude', [], 'chat', false, { permissionMode: 'readOnly' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    expect(service.list()).toHaveLength(1)
  })

  it('switches a project\'s branch while the agent is idle, counting changes from there and telling the agent next', async () => {
    const repo = path.join(root, 'app')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('branch', 'feature')
    git('checkout', '-q', 'feature')
    git('commit', '-q', '--allow-empty', '-m', 'feature work')
    git('checkout', '-q', 'main')
    const created = await service.create('claude', [repo], 'chat')
    const [project] = created.projectPaths
    await settle()

    const options = await service.branchOptions(created.id)
    expect(options).toMatchObject([{ path: project, git: true, branch: 'main', sharedWith: [] }])
    expect(options[0]?.refs.sort()).toEqual(['refs/heads/feature', 'refs/heads/main'])
    await service.switchBranch(created.id, project!, 'refs/heads/feature')
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('feature')
    // The feature branch's own commit is not the conversation's doing.
    expect((await service.changes(created.id))[0]?.commits).toEqual([])
    await service.createBranch(created.id, project!, 'fix/login')

    await service.send(created.id, 'Carry on')
    await settle()
    expect(service.messages(created.id).map((message) => message.text)[0])
      .toBe('（我切换了分支：app 现在在分支 fix/login。文件已经变了，需要时请重新读。）\n\nCarry on')
    // The title is the user's own words.
    expect(service.get(created.id).title).toBe('Carry on')
    await service.send(created.id, 'And then')
    await settle()
    expect(service.messages(created.id).filter((message) => message.role === 'user').map((message) => message.text)[1]).toBe('And then')
    await expect(service.switchBranch(created.id, root, 'refs/heads/main')).rejects.toMatchObject({ reason: 'repo-not-found' })
  })

  it('offers a new chat the models the agent listed last, after a restart too, and starts with one picked', async () => {
    const created = await service.create('claude', [], 'chat')
    const ids = async () => (await service.chatCatalog('claude'))?.models.map((model) => model.id)
    expect(await ids()).toEqual(['sonnet', 'haiku'])
    await service.stop(created.id)
    service = serve()
    expect(await ids()).toEqual(['sonnet', 'haiku'])
    await service.create('claude', [], 'chat', false, { model: 'haiku' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'haiku']))
    // An effort alone goes with the default model, Sonnet here.
    await service.create('claude', [], 'chat', false, { effort: 'high' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--effort', 'high']))
    await expect(service.create('claude', [], 'chat', false, { model: 'opus' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await expect(service.create('claude', [], 'chat', false, { model: 'haiku', effort: 'low' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
  })

  it('takes options for the next start while no agent runs, from what the last stage offered', async () => {
    const created = await service.create('claude', [], 'chat')
    await service.stop(created.id)
    await service.setOption(created.id, 'model', 'sonnet')
    await service.setOption(created.id, 'effort', 'high')
    await service.setOption(created.id, 'permissionMode', 'plan')
    expect(service.get(created.id).chatOptions).toEqual({ permissionMode: 'plan', model: 'sonnet', effort: 'high' })
    await expect(service.setOption(created.id, 'model', 'opus')).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await expect(service.setOption(created.id, 'effort', 'max')).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await expect(service.setOption(created.id, 'permissionMode', 'readOnly')).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    // Haiku takes no effort, so the one chosen for Sonnet goes with it.
    await service.setOption(created.id, 'model', 'haiku')
    expect(service.get(created.id).chatOptions).toMatchObject({ model: 'haiku', effort: null })
    await service.setOption(created.id, 'model', 'sonnet')
    await service.setOption(created.id, 'effort', 'low')
    await service.continue(created.id, 'chat')
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'low']))
  })

  it('lets an idle chat agent go after 30 minutes, and never one with work in hand', async () => {
    const idle = await service.create('claude', [], 'chat')
    await service.send(idle.id, 'first')
    await settle()
    daemon.reply = () => {}
    const busy = await service.create('claude', [], 'chat')
    await service.send(busy.id, 'still going')
    await settle()
    await service.releaseIdle(Date.now() + 29 * 60_000)
    expect(service.get(idle.id).sessionId).not.toBeNull()
    await service.releaseIdle(Date.now() + 31 * 60_000)
    expect(service.get(idle.id)).toMatchObject({ sessionId: null, lastExit: { code: null } })
    expect(service.get(busy.id).sessionId).not.toBeNull()
  })

  it('makes way for the terminal or a handoff from an idle chat agent, but not a working one', async () => {
    const created = await service.create('claude', [], 'chat')
    const chat = created.sessionId!
    await service.continue(created.id, 'tui')
    expect(daemon.killed).toEqual([{ sessionId: chat, force: false }])
    expect(service.get(created.id).mode).toBe('tui')
    await expect(service.continue(created.id, 'chat')).rejects.toMatchObject({ reason: 'conversation-running' })

    const idle = await service.create('claude', [], 'chat')
    expect((await service.handoff(idle.id, 'codex', '', false, 'tui')).agent).toBe('codex')
    daemon.reply = () => {}
    const working = await service.create('claude', [], 'chat')
    await service.send(working.id, 'still going')
    await settle()
    await expect(service.handoff(working.id, 'codex', '', false, 'tui')).rejects.toMatchObject({ reason: 'conversation-running' })
    await expect(service.continue(working.id, 'tui')).rejects.toMatchObject({ reason: 'conversation-running' })
  })

  const task = { id: 'task-1', title: 'Chat me', agent: 'claude' as const }
  const exitPlanMode = (requestId: string) => ({
    type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: `toolu_${requestId}` }
  })
  const sessionArg = (args: readonly string[]) => args[args.indexOf('--session-id') + 1]

  it('starts a task\'s chat afresh in plan mode, then goes on with the same session in the same folder', async () => {
    const started = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new' })
    expect(started).toMatchObject({ taskId: 'task-1', title: 'Chat me', titleLocked: true, mode: 'chat', workspacePath: realpathSync(root) })
    const first = daemon.spawns.at(-1)!.args
    expect(first).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--session-id']))
    await service.send(started.id, 'go')
    await settle()
    // Going on with the live agent leaves it as it is.
    await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'resume' })
    expect(daemon.spawns).toHaveLength(1)
    await service.stop(started.id)
    await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'resume' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', sessionArg(first)]))
    expect(service.list()).toEqual([])
    await expect(service.continue(started.id, 'chat')).rejects.toMatchObject({ reason: 'task-conversation' })
    await expect(service.handoff(started.id, 'codex', '', true, 'chat')).rejects.toMatchObject({ reason: 'task-conversation' })
    await expect(service.delete(started.id)).rejects.toMatchObject({ reason: 'task-conversation' })
  })

  it('keeps a plan-only stage read-only across a core restart, and keeps its plan when asked', async () => {
    const web = mkdtempSync(path.join(root, 'web-'))
    const planning = await service.startForTask(task, { cwd: root, extraDirs: [web], planOnly: true, session: 'new', allowBypass: true })
    const args = daemon.spawns.at(-1)!.args
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--disallowedTools', `Edit(/${realpathSync(root)}/**),Edit(/${realpathSync(web)}/**)`]))
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
    const [stage] = service.stages(planning.id)
    expect(stage?.planOnly).toBe(true)

    service = serve()
    await service.reconcile((await daemon.request('list', {})).sessions)
    daemon.emit(planning.sessionId!, exitPlanMode('plan-1'))
    await settle()
    await expect(service.respond(planning.id, 'plan-1', { decision: 'allow' })).rejects.toMatchObject({ reason: 'plan-only' })
    expect(await service.savePlan(planning.id, stage!.id, 'plan-1')).toEqual({ markdown: '# Plan', agent: 'claude' })
    expect(daemon.written(planning.sessionId!).at(-1)).toMatchObject({ response: { request_id: 'plan-1', response: { behavior: 'deny' } } })
  })

  it('starts a Claude stage moved to another folder from a handoff rather than resuming it', async () => {
    const worktree = mkdtempSync(path.join(root, 'wt-'))
    const planning = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: true, session: 'new' })
    await service.send(planning.id, 'hello')
    await settle()
    await service.stop(planning.id)
    const moved = await service.startForTask(task, { cwd: worktree, extraDirs: [], planOnly: false, session: 'resume' })
    expect(moved.workspacePath).toBe(realpathSync(worktree))
    const args = daemon.spawns.at(-1)!.args
    expect(args).not.toContain('--resume')
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', expect.stringContaining('handoffs')]))
    const sessionId = service.get(moved.id).sessionId!
    expect(JSON.stringify(daemon.written(sessionId))).toContain('请先阅读 Kando 移交文件')
    expect(service.stages(moved.id).map((each) => each.planOnly)).toEqual([true, false])
  })

  it('goes on with the same Claude session when only another directory is added', async () => {
    const web = mkdtempSync(path.join(root, 'web-'))
    const started = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new' })
    const first = daemon.spawns.at(-1)!.args
    await service.send(started.id, 'hello')
    await settle()
    const regrouped = await service.startForTask(task, { cwd: root, extraDirs: [web], planOnly: false, session: 'resume' })
    expect(regrouped.projectPaths).toEqual([realpathSync(root), realpathSync(web)])
    expect(daemon.spawns).toHaveLength(2)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', sessionArg(first), '--add-dir', realpathSync(web)]))
    expect(JSON.stringify(daemon.written(service.get(started.id).sessionId!))).not.toContain('请先阅读 Kando 移交文件')
  })

  it('restarts an idle chat agent on its session to give it the additional projects, the primary kept', async () => {
    const app = mkdtempSync(path.join(root, 'app-'))
    const web = mkdtempSync(path.join(root, 'web-'))
    const created = await service.create('claude', [app], 'chat')
    const first = daemon.spawns.at(-1)!.args
    await service.send(created.id, 'hello')
    await settle()
    const added = await service.setAdditionalProjects(created.id, [web])
    expect(added.projectPaths).toEqual([realpathSync(app), realpathSync(web)])
    expect(daemon.spawns).toHaveLength(2)
    expect(daemon.spawns.at(-1)).toMatchObject({ cwd: realpathSync(app) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', sessionArg(first), '--add-dir', realpathSync(web)]))
    expect(projects.recent()).toContain(web)
    // The same list again changes nothing; the primary cannot come in as one of them.
    await service.setAdditionalProjects(created.id, [web])
    expect(daemon.spawns).toHaveLength(2)
    await expect(service.setAdditionalProjects(created.id, [app])).rejects.toMatchObject({ reason: 'duplicate-project' })
    await service.stop(created.id)
    const removed = await service.setAdditionalProjects(created.id, [])
    expect(removed.projectPaths).toEqual([realpathSync(app)])
    expect(removed.sessionId).toBeNull()
    expect(daemon.spawns).toHaveLength(2)
  })

  it('keeps the additional projects of a working agent, a task\'s chat and a projectless conversation', async () => {
    const web = mkdtempSync(path.join(root, 'web-'))
    daemon.reply = () => {}
    const working = await service.create('claude', [root], 'chat')
    await service.send(working.id, 'still going')
    await settle()
    await expect(service.setAdditionalProjects(working.id, [web])).rejects.toMatchObject({ reason: 'chat-busy' })
    const scratch = await service.create('claude', [], 'chat')
    await expect(service.setAdditionalProjects(scratch.id, [web])).rejects.toMatchObject({ reason: 'managed-workspace' })
    const started = await service.startForTask(task, { cwd: web, extraDirs: [], planOnly: false, session: 'new' })
    await expect(service.setAdditionalProjects(started.id, [root])).rejects.toMatchObject({ reason: 'task-conversation' })
  })

  it('deletes a task\'s chat with its task, logs and all', async () => {
    const started = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new' })
    await service.deleteForTask(task.id)
    expect(() => service.get(started.id)).toThrow(expect.objectContaining({ reason: 'conversation-not-found' }))
    expect(existsSync(path.join(root, 'sessions', started.id))).toBe(false)
    await service.deleteForTask('no-such-task')
  })

  it('takes a running chat stage back after core restarts', async () => {
    const created = await service.create('claude', [], 'chat')
    await service.send(created.id, 'first')
    await settle()
    const written = daemon.written(created.sessionId!).length

    service = serve()
    await service.reconcile((await daemon.request('list', {})).sessions)
    expect(daemon.written(created.sessionId!)).toHaveLength(written)
    await service.send(created.id, 'second')
    await settle()
    expect(service.messages(created.id).map((message) => message.text))
      .toEqual(['first', 'echo: first', 'second', 'echo: second'])
  })
  it('sends only images the store holds, each once, and notes them in the message it keeps', async () => {
    const created = await service.create('claude', [], 'chat')
    await expect(service.send(created.id, 'see', [`${'b'.repeat(64)}.png`])).rejects.toMatchObject({ reason: 'attachment-not-found' })
    const stored = await attachmentsAt(root).put(pngBytes(4, 3))
    await service.send(created.id, 'see', [stored.id, stored.id])
    await settle()
    expect(daemon.written(created.sessionId!).at(-1)).toMatchObject({ message: { content: [{ type: 'image' }, { type: 'text', text: 'see' }] } })
    expect(service.chatPage(created.id).items.find((item) => item.kind === 'user')).toMatchObject({ images: [{ id: stored.id, width: 4, height: 3 }] })
    expect(service.messages(created.id)[0]?.text).toBe('see\n\n（附了 1 张图片）')
  })
})
