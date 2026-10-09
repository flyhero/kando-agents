import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationService, type ConversationEvent } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { AttachmentStore } from './attachment-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { pngBytes } from './image-fixtures'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

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
  let daemon: ReturnType<typeof fakeChatDaemon>
  let service: ConversationService

  function serve(emit: (event: ConversationEvent) => void = () => {}): ConversationService {
    const next = new ConversationService(store, daemon, path.join(root, 'sessions'), emit, projects, attachmentsAt(root), null, path.join(root, 'worktrees'))
    daemon.deliver = (event) => {
      if (event.event === 'data') next.handleData(event)
      else if (event.event === 'exit') next.handleExit(event.sessionId, event.exitCode)
      else next.handleStderr(event.sessionId, event.data)
    }
    return next
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const sessionArg = (args: readonly string[]) => args[args.indexOf('--session-id') + 1]

  // Answers the next Codex start like app-server: the handshake, then the thread it asks for.
  async function codexOpens<T>(starting: Promise<T>, thread = 'thread-1'): Promise<T> {
    const sessionId = `pipe-${daemon.spawns.length + 1}`
    const asked = (method: string) => daemon.written(sessionId).some((frame) => JSON.stringify(frame).includes(`"method":"${method}"`))
    while (!asked('initialize')) await settle()
    daemon.emit(sessionId, { id: 'kando-init', result: {} })
    while (!asked('thread/start') && !asked('thread/resume')) await settle()
    daemon.emit(sessionId, { id: 'kando-thread', result: { thread: { id: thread } } })
    return starting
  }

  // A message as the conversation's latest stage records one.
  function say(conversationId: string, role: 'user' | 'assistant', text: string): void {
    const stage = service.stages(conversationId).at(-1)!
    store.addMessage({ conversationId, stageId: stage.id, role, agent: stage.agent, text, eventKey: randomUUID(), complete: true })
  }

  // The handoff file the agent of this session was told to read first.
  const handoffFile = (sessionId: string) =>
    readFileSync(/移交文件 (\S+?)，/.exec(JSON.stringify(daemon.written(sessionId)))?.[1] ?? '', 'utf8')

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-conversation-'))
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

  it('does not start or send an agent turn while Git holds its repository', async () => {
    const created = await service.create('claude', [], false, { deferStart: true })
    service.setGitGuard(async () => { throw new Error('Git is busy') })
    await expect(service.continue(created.id)).rejects.toThrow('Git is busy')
    expect(daemon.spawns).toHaveLength(0)
    expect(service.get(created.id).starting).toBe(false)
    await expect(service.send(created.id, 'start')).rejects.toThrow('Git is busy')
    expect(service.isGitPending(created.id)).toBe(false)
    expect(daemon.spawns).toHaveLength(0)
  })

  it('commits and pushes only a conversation project, while its agent is idle', async () => {
    const repo = path.join(root, 'app')
    const remote = path.join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Kando Test'])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'kando@example.com'])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    writeFileSync(path.join(repo, 'note.txt'), 'hello\n')
    const echo = daemon.reply
    daemon.reply = () => {}
    const created = await service.create('claude', [repo])
    const project = created.projectPaths[0]!
    await service.send(created.id, 'still going')
    await settle()

    await expect(service.commitPush(created.id, project, 'feat: add note')).rejects.toMatchObject({ reason: 'chat-busy' })
    // The turn ends.
    echo(created.sessionId!, 'still going')
    await settle()
    await expect(service.commitPush(created.id, root, 'feat: add note')).rejects.toMatchObject({ reason: 'repo-not-found' })
    const result = await service.commitPush(created.id, project, 'feat: add note')

    expect(result).toMatchObject({ branch: 'main', upstream: 'origin/main' })
    expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe('feat: add note')
  })

  it('creates a conversation before its agent handshake and keeps the chosen mode for launch', async () => {
    const created = await service.create('codex', [], false, { permissionMode: 'plan', deferStart: true })
    expect(created.sessionId).toBeNull()
    expect(created.chatOptions?.permissionMode).toBe('plan')
    expect(store.get(created.id)).not.toBeNull()
    expect(daemon.spawns).toHaveLength(0)
    expect(service.stages(created.id)).toHaveLength(0)

    let ready = false
    const starting = service.continue(created.id).then((conversation) => { ready = true; return conversation })
    await settle()
    expect(daemon.spawns).toHaveLength(1)
    expect(ready).toBe(false)
    expect(service.get(created.id).sessionId).toBe('pipe-1')
    expect(service.get(created.id).starting).toBe(true)
    daemon.emit('pipe-1', { id: 'kando-init', result: {} })
    await settle()
    daemon.emit('pipe-1', { id: 'kando-thread', result: { thread: { id: 'new-thread' } } })
    await expect(starting).resolves.toMatchObject({ id: created.id, sessionId: 'pipe-1', starting: false })
    expect(service.get(created.id).starting).toBe(false)
  })

  it('keeps a deferred conversation after launch fails and sends a retried message once', async () => {
    const created = await service.create('claude', [], false, { permissionMode: 'plan', deferStart: true })
    daemon.answerInit = false
    const starting = service.continue(created.id)
    const failed = expect(starting).rejects.toThrow()
    await settle()
    daemon.exit('pipe-1', 1)
    await failed
    expect(service.get(created.id)).toMatchObject({ sessionId: null, starting: false, chatOptions: { permissionMode: 'plan' } })

    daemon.answerInit = true
    const continued = await service.continue(created.id)
    daemon.reply = () => {}
    const ref = randomUUID()
    await service.send(created.id, 'first message', [], false, false, ref)
    await service.send(created.id, 'first message', [], false, false, ref)
    expect(daemon.written(continued.sessionId!).filter((frame) => JSON.stringify(frame).includes('first message'))).toHaveLength(1)
    expect(service.chatPage(created.id).items.filter((item) => item.kind === 'user')).toHaveLength(1)
    await service.stop(created.id)
    service = serve()
    const resumed = await service.continue(created.id)
    await service.send(created.id, 'first message', [], false, false, ref)
    expect(daemon.written(resumed.sessionId!).filter((frame) => JSON.stringify(frame).includes('first message'))).toHaveLength(0)
  })

  it('creates a deferred Cursor conversation without starting or checking its CLI', async () => {
    const created = await service.create('cursor', [], false, { deferStart: true })
    expect(created).toMatchObject({ agent: 'cursor', sessionId: null })
    expect(daemon.spawns).toHaveLength(0)
  })

  it('starts in a persistent isolated workspace and restores its native conversation', async () => {
    const created = await service.create('claude', [])
    expect(created.workspacePath).toBe(path.join(root, 'sessions', created.id, 'workspace'))
    expect(daemon.spawns[0]).toMatchObject({ command: 'claude', cwd: created.workspacePath })
    const providerId = service.stages(created.id)[0]?.providerSessionId
    expect(sessionArg(daemon.spawns[0]!.args)).toBe(providerId)
    // An agent already up is left as it is.
    await service.continue(created.id)
    expect(daemon.spawns).toHaveLength(1)
    await service.send(created.id, 'Hello')
    await settle()
    await service.stop(created.id)
    await service.continue(created.id)
    expect(daemon.spawns[1]?.args).toEqual(expect.arrayContaining(['--resume', providerId]))
  })

  it('limits live agents by machine and provider, then admits a new one after a process exits', async () => {
    let released = 0
    service.setCapacity({ maxConcurrentAgents: 2, agentConcurrency: { claude: 1, codex: 2 } }, () => { released++ })
    const claude = await service.create('claude', [])
    const codex = await codexOpens(service.create('codex', []))
    expect(service.capacityAvailable('claude')).toBe(false)
    expect(service.capacityAvailable('codex')).toBe(false)
    await expect(service.create('claude', [])).rejects.toMatchObject({ reason: 'agent-capacity' })
    await expect(service.create('codex', [])).rejects.toMatchObject({ reason: 'agent-capacity' })
    expect(daemon.spawns).toHaveLength(2)

    daemon.exit(claude.sessionId!, 0)
    expect(released).toBeGreaterThan(0)
    expect(service.capacityAvailable('claude')).toBe(true)
    expect(service.capacityAvailable('codex')).toBe(true)
    await codexOpens(service.create('codex', []), 'thread-2')
    expect(daemon.spawns).toHaveLength(3)
    expect(service.get(codex.id).sessionId).toBe(codex.sessionId)
  })

  it('counts persisted live sessions while core reconnects to the daemon', async () => {
    const first = await service.create('claude', [])
    const recovered = serve()
    recovered.setCapacity({ maxConcurrentAgents: 1, agentConcurrency: { claude: 1 } }, () => {})
    expect(recovered.capacityAvailable('claude')).toBe(false)
    await recovered.reconcile((await daemon.request('list', {})).sessions)
    expect(recovered.capacityAvailable('claude')).toBe(false)
    daemon.exit(first.sessionId!, 0)
    expect(recovered.capacityAvailable('claude')).toBe(true)
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
    const codex = await codexOpens(service.handoff(created.id, 'codex', '', false))
    expect(daemon.spawns[1]).toMatchObject({ command: 'codex', cwd: realpathSync(first) })
    // Codex is given them with each turn, the handoff's first.
    expect(daemon.written(codex.sessionId!).find((frame) => JSON.stringify(frame).includes('turn/start')))
      .toMatchObject({ params: { sandboxPolicy: { writableRoots: [realpathSync(second)] } } })
    await expect(service.create('codex', [first, first])).rejects.toThrow('duplicate-project')
  })

  it('works in a worktree of each project on a branch of its own, leaving the projects as they were', async () => {
    const repo = (name: string) => {
      const dir = path.join(root, name)
      execFileSync('git', ['init', '-q', '-b', 'main', dir])
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
      return dir
    }
    const app = repo('app')
    const lib = repo('lib')
    writeFileSync(path.join(app, 'draft.md'), 'stays here\n')
    const created = await service.create('claude', [app, lib], undefined, { worktree: true })
    const shortId = created.id.slice(0, 8)
    const laidOut = [path.join(root, 'worktrees', shortId, 'app'), path.join(root, 'worktrees', shortId, 'lib')].map((dir) => realpathSync(dir))
    expect(created.projectPaths).toEqual(laidOut)
    expect(daemon.spawns[0]).toMatchObject({ cwd: laidOut[0] })
    expect((await service.branches(created.id)).map((head) => head.branch)).toEqual([`kando/${shortId}`, `kando/${shortId}`])
    expect(existsSync(path.join(laidOut[0]!, 'draft.md'))).toBe(false)
    expect(execFileSync('git', ['-C', app, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main')
    // The recent list keeps the projects as picked, not their worktrees.
    expect([...projects.recent()].sort()).toEqual([app, lib])
  })

  it('starts on the branch picked: a worktree from it, or the project switched to it', async () => {
    const app = path.join(root, 'app')
    const git = (...args: string[]) => execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '-b', 'main', app])
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('switch', '-q', '-c', 'feature')
    git('commit', '-q', '--allow-empty', '-m', 'on feature')
    git('switch', '-q', 'main')
    expect(await service.projectBranchOptions(app)).toMatchObject({ branch: 'main', refs: expect.arrayContaining(['refs/heads/main', 'refs/heads/feature']) })

    // In a worktree, the conversation's branch starts from the one picked; the project stays put.
    const worked = await service.create('claude', [app], undefined, { worktree: true, branch: 'refs/heads/feature' })
    const branch = `kando/${worked.id.slice(0, 8)}`
    expect(git('log', '-1', '--format=%s', branch)).toBe('on feature')
    expect(git('branch', '--show-current')).toBe('main')

    // In the project, it is switched to the branch first; with tracked changes it is not, and
    // nothing is made.
    const switched = await service.create('claude', [app], undefined, { branch: 'refs/heads/feature' })
    expect(switched.projectPaths).toEqual([realpathSync(app)])
    expect(git('branch', '--show-current')).toBe('feature')
    writeFileSync(path.join(app, 'tracked.md'), 'one\n')
    git('add', 'tracked.md')
    git('commit', '-q', '-m', 'track')
    writeFileSync(path.join(app, 'tracked.md'), 'changed\n')
    const before = service.list().length
    await expect(service.create('claude', [app], undefined, { branch: 'refs/heads/main' })).rejects.toMatchObject({ reason: 'uncommitted-changes' })
    expect(service.list()).toHaveLength(before)
    expect(git('branch', '--show-current')).toBe('feature')
  })

  it('lays no worktree out unless every project is a git repo', async () => {
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    await expect(service.create('claude', [plain], undefined, { worktree: true })).rejects.toMatchObject({ reason: 'worktree-not-git' })
    await expect(service.create('claude', [], undefined, { worktree: true })).rejects.toMatchObject({ reason: 'missing-repo' })
    expect(existsSync(path.join(root, 'worktrees'))).toBe(false)
    expect(service.list()).toEqual([])
  })

  it('adds its projects to the recent list tasks pick from, but not the managed workspace', async () => {
    const project = path.join(root, 'project')
    mkdirSync(project)
    await service.create('claude', [])
    expect(projects.recent()).toEqual([])
    await service.create('claude', [project])
    expect(projects.recent()).toEqual([project])
  })

  it('pins and unpins a conversation without counting it as activity, but not a task\'s', () => {
    const events: ConversationEvent[] = []
    service = serve((event) => events.push(event))
    const created = store.create('claude', root, [root])
    const pinned = service.setPinned(created.id, true)
    expect(pinned.pinnedAt).toEqual(expect.any(Number))
    expect(pinned.updatedAt).toBe(created.updatedAt)
    expect(events).toEqual([{ type: 'changed', conversation: pinned }])
    expect(service.setPinned(created.id, true).pinnedAt).toBe(pinned.pinnedAt)
    expect(events).toHaveLength(1)
    expect(service.setPinned(created.id, false).pinnedAt).toBeNull()

    const task = store.create('claude', root, [root], randomUUID(), {}, { id: randomUUID(), title: 'Task' })
    expect(() => service.setPinned(task.id, true)).toThrow(expect.objectContaining({ reason: 'task-conversation' }))
  })

  it('passes only unseen messages on a return handoff, which resumes the first agent under the title the user gave', async () => {
    const created = await service.create('claude', [root])
    const [first] = service.stages(created.id)
    await service.send(created.id, 'Build an API')
    await settle()
    service.rename(created.id, 'Custom')
    const codex = await codexOpens(service.handoff(created.id, 'codex', 'Please review', false))
    expect(daemon.spawns.at(-1)?.cwd).toBe(realpathSync(root))
    const initial = handoffFile(codex.sessionId!)
    expect(initial).toContain('Build an API')
    expect(initial).toContain('Please review')
    say(created.id, 'user', 'Verify tests')
    say(created.id, 'assistant', 'Tests pass')

    const back = await service.handoff(created.id, 'claude', '', true)
    const delta = handoffFile(back.sessionId!)
    expect(delta).toContain('Verify tests')
    expect(delta).not.toContain('Build an API')
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume', first!.providerSessionId]))
    expect(service.get(created.id)).toMatchObject({ title: 'Custom', titleLocked: true })
  })

  it('starts Claude afresh, with the whole conversation, when the session id it picked was never saved', async () => {
    const created = await codexOpens(service.create('codex', [root]))
    say(created.id, 'user', 'Fix the build')
    // Claude goes before it saves anything of its session.
    daemon.reply = () => {}
    const handed = await service.handoff(created.id, 'claude', '', true)
    const unsaved = service.stages(created.id)[1]!.providerSessionId
    daemon.exit(handed.sessionId!, 1)
    const continued = await service.continue(created.id)
    const args = daemon.spawns.at(-1)?.args ?? []
    expect(args).not.toContain('--resume')
    expect(sessionArg(args)).not.toBe(unsaved)
    expect(handoffFile(continued.sessionId!)).toContain('Fix the build')
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
    daemon.exit(created.sessionId!, 0)
    expect(service.get(created.id).lastExit).toMatchObject({ code: 0 })
    const resumed = await service.continue(created.id)
    expect(resumed.lastExit).toMatchObject({ code: 0 })
    daemon.exit(resumed.sessionId!, 1)
    expect(service.get(created.id).lastExit).toMatchObject({ code: 1 })
    await service.continue(created.id)
    expect((await service.stop(created.id)).lastExit).toMatchObject({ code: null })
  })

  it('finds conversations by message text, once each, with the latest match', async () => {
    const first = await service.create('claude', [root])
    const second = await service.create('claude', [root])
    say(first.id, 'user', 'Fix the Login redirect')
    say(first.id, 'assistant', 'The login page now redirects home')
    say(second.id, 'user', '整理这周的周报')
    expect(service.search('LOGIN')).toEqual([{ conversationId: first.id, snippet: 'The login page now redirects home' }])
    expect(service.search('周报')).toEqual([{ conversationId: second.id, snippet: '整理这周的周报' }])
    expect(service.search('nothing like it')).toEqual([])
  })

  it('keeps a task\'s conversation out of the free list and their search', async () => {
    const free = await service.create('claude', [root])
    const owner = tasks.create('Chat me')
    const own = store.create('claude', root, [root], undefined, {}, { id: owner.id, title: owner.title })
    store.startStage(own.id, 'claude', null, 0)
    say(free.id, 'user', 'Fix the login page')
    say(own.id, 'user', 'Fix the login form')
    expect(service.list().map((conversation) => conversation.id)).toEqual([free.id])
    expect(service.list(false).map((conversation) => conversation.id)).toEqual([free.id])
    expect(service.list(true).map((conversation) => conversation.id).sort()).toEqual([free.id, own.id].sort())
    expect(service.search('login').map((hit) => hit.conversationId)).toEqual([free.id])
    expect(service.get(own.id).taskId).toBe(owner.id)
  })

  it('deletes a conversation with its agent and files, but keeps the workspace Kando made for it', async () => {
    const created = await service.create('claude', [])
    await service.send(created.id, 'Hello')
    await settle()
    const directory = path.join(root, 'sessions', created.id)
    await service.delete(created.id)
    expect(daemon.killed).toEqual([{ sessionId: created.sessionId, force: false }])
    expect(existsSync(created.workspacePath)).toBe(true)
    expect(readdirSync(directory)).toEqual(['workspace'])
    expect(service.list()).toEqual([])
  })

  it('runs Claude over stream-json and keeps its messages', async () => {
    const announced: unknown[] = []
    service = serve((event) => { if (event.type === 'changed') announced.push(event.conversation.chat) })
    const created = await service.create('claude', [])
    // Clients hear that the agent is ready, not only that the conversation exists.
    expect(announced.at(-1)).toEqual({ turn: 'idle' })
    expect(created).toMatchObject({ chat: { turn: 'idle' } })
    const args = daemon.spawns[0]?.args ?? []
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session-id']))
    expect(args).not.toContain('--settings')

    await service.send(created.id, 'Refactor the parser')
    await settle()
    expect(service.messages(created.id).map((message) => [message.role, message.text]))
      .toEqual([['user', 'Refactor the parser'], ['assistant', 'echo: Refactor the parser']])
    expect(service.get(created.id).title).toBe('Refactor the parser')
    expect(service.chatPage(created.id).items.map((item) => item.kind).filter((kind) => kind !== 'state')).toEqual(['user', 'assistant', 'turn'])
  })

  it('shows a Claude chat\'s suggested next message while it is idle, as long as the settings want one', async () => {
    service.setPromptSuggestions(true)
    const echo = daemon.reply
    daemon.reply = (sessionId, text) => {
      echo(sessionId, text)
      daemon.emit(sessionId, { type: 'prompt_suggestion', suggestion: 'run the tests', uuid: 'u-1', session_id: 's-1' })
    }
    const created = await service.create('claude', [])
    expect(daemon.writes.map((write) => write.frame)).toContainEqual(expect.objectContaining({ request: { subtype: 'initialize', promptSuggestions: true } }))

    await service.send(created.id, 'Fix the parser')
    await settle()
    expect(service.get(created.id).chat).toEqual({ turn: 'idle', suggestion: 'run the tests' })

    service.setPromptSuggestions(false)
    expect(service.get(created.id).chat).toEqual({ turn: 'idle' })
    expect(daemon.writes.map((write) => write.frame)).toContainEqual(expect.objectContaining({ request: { subtype: 'set_prompt_suggestions_paused', paused: true } }))
  })

  it('stops a chat agent only once it has exited, forcing it when it will not go', async () => {
    const created = await service.create('claude', [])
    const sessionId = created.sessionId!
    await service.stop(created.id)
    expect(daemon.killed).toEqual([{ sessionId, force: false }])
    expect(daemon.released).toContain(sessionId)
    expect(service.get(created.id).sessionId).toBeNull()
  })

  it('hands off with the handoff prompt as the first message, kept out of the messages and the title', async () => {
    const created = await codexOpens(service.create('codex', []))
    await service.stop(created.id)
    const handed = await service.handoff(created.id, 'claude', 'watch the tests', false)
    const [first] = daemon.written(handed.sessionId!).filter((frame) => JSON.stringify(frame).includes('"type":"user"'))
    expect(JSON.stringify(first)).toContain('请先阅读 Kando 移交文件')
    await settle()
    expect(service.messages(created.id).filter((message) => message.role === 'user')).toEqual([])
    expect(service.get(created.id).title).toBe('新会话')
  })

  it('runs Codex through app-server and binds the thread it opens', async () => {
    const created = await codexOpens(service.create('codex', []))
    expect(daemon.spawns[0]).toMatchObject({ command: 'codex', args: ['app-server'] })
    expect(daemon.written('pipe-1').find((frame) => JSON.stringify(frame).includes('thread/start')))
      .toMatchObject({ params: { approvalPolicy: 'on-request', sandbox: 'workspace-write' } })
    expect(service.stages(created.id)[0]?.providerSessionId).toBe('thread-1')
  })

  it('answers a question Codex asks in passing with a message, into the turn while it runs and after it otherwise', async () => {
    const created = await codexOpens(service.create('codex', []))
    const sessionId = created.sessionId!
    daemon.reply = () => {}
    await service.send(created.id, 'release it')
    await settle()
    daemon.emit(sessionId, { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    const asked = (id: string) => ({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id, text: '可以提交吗？\n- 可以\n- 先不要', delivery: 'async', questions: [{ title: '可以提交吗？', options: ['可以', '先不要'] }] } }
    })
    daemon.emit(sessionId, asked('call_1'))
    expect(service.get(created.id).chat).toMatchObject({ turn: 'running', request: { requestId: 'async:call_1', kind: 'question', title: '可以提交吗？', open: 1, async: true } })

    await service.respond(created.id, 'async:call_1', { decision: 'allow', answers: { q1: ['可以'] } })
    expect(daemon.written(sessionId).at(-1)).toMatchObject({ method: 'turn/steer', params: { input: [{ type: 'text', text: '可以' }], expectedTurnId: 'turn-1' } })
    expect(service.get(created.id).chat?.request).toBeUndefined()

    daemon.emit(sessionId, asked('call_2'))
    daemon.emit(sessionId, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    expect(service.get(created.id).chat).toMatchObject({ turn: 'idle', request: { requestId: 'async:call_2', async: true } })
    await service.respond(created.id, 'async:call_2', { decision: 'allow', answers: { q1: ['先不要'] } })
    expect(daemon.written(sessionId).at(-1)).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: '先不要' }] } })
  })

  it('drops a chat stage that fails to start, leaving nothing to resume', async () => {
    daemon.answerInit = false
    daemon.reply = () => {}
    const creating = service.create('claude', [])
    while (!daemon.sessions.get('pipe-1')) await settle()
    daemon.sessions.get('pipe-1')!.stderr = 'Not logged in'
    daemon.exit('pipe-1', 1)
    await expect(creating).rejects.toMatchObject({ reason: 'chat-start-failed' })
    const [conversation] = service.list()
    expect(service.stages(conversation!.id)).toEqual([])
    expect(conversation?.sessionId).toBeNull()
  })

  it('remembers a switched option for the next start, and bypass only when allowed', async () => {
    const created = await service.create('claude', [])
    await service.setOption(created.id, 'permissionMode', 'plan')
    expect(daemon.written(created.sessionId!).at(-1)).toMatchObject({ request: { subtype: 'set_permission_mode', mode: 'plan' } })
    await expect(service.setOption(created.id, 'permissionMode', 'bypass')).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await service.stop(created.id)
    await service.continue(created.id, true)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--allow-dangerously-skip-permissions']))
  })

  it('remembers the mode the stage was left in, as approving a plan leaves it', async () => {
    const created = await service.create('claude', [])
    await service.setOption(created.id, 'permissionMode', 'plan')
    await settle()
    // Carrying out the plan with edits accepted: Claude reports the switch itself.
    daemon.emit(created.sessionId!, { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })
    await settle()
    await service.stop(created.id)
    await service.continue(created.id)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
  })

  it('starts a new chat in the permission mode picked for it, one the agent has', async () => {
    const created = await service.create('claude', [], false, { permissionMode: 'plan' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(service.get(created.id).chatOptions?.permissionMode).toBe('plan')
    await expect(service.create('claude', [], false, { permissionMode: 'readOnly' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
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
    const created = await service.create('claude', [repo])
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
    const created = await service.create('claude', [])
    const ids = async () => (await service.chatCatalog('claude'))?.models.map((model) => model.id)
    expect(await ids()).toEqual(['sonnet', 'haiku'])
    await service.stop(created.id)
    service = serve()
    expect(await ids()).toEqual(['sonnet', 'haiku'])
    await service.create('claude', [], false, { model: 'haiku' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'haiku']))
    // An effort alone goes with the default model, Sonnet here.
    await service.create('claude', [], false, { effort: 'high' })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--effort', 'high']))
    await expect(service.create('claude', [], false, { model: 'opus' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
    await expect(service.create('claude', [], false, { model: 'haiku', effort: 'low' })).rejects.toMatchObject({ reason: 'chat-option-invalid' })
  })

  it('takes options for the next start while no agent runs, from what the last stage offered', async () => {
    const created = await service.create('claude', [])
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
    await service.continue(created.id)
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'low']))
  })

  it('lets an idle chat agent go after 30 minutes, and never one with work in hand', async () => {
    const idle = await service.create('claude', [])
    await service.send(idle.id, 'first')
    await settle()
    daemon.reply = () => {}
    const busy = await service.create('claude', [])
    await service.send(busy.id, 'still going')
    await settle()
    await service.releaseIdle(Date.now() + 29 * 60_000)
    expect(service.get(idle.id).sessionId).not.toBeNull()
    await service.releaseIdle(Date.now() + 31 * 60_000)
    expect(service.get(idle.id)).toMatchObject({ sessionId: null, lastExit: { code: null } })
    expect(service.get(busy.id).sessionId).not.toBeNull()
  })

  it('makes way for a handoff from an idle agent but not a working one, which a continue leaves as it is', async () => {
    const idle = await service.create('claude', [])
    expect((await codexOpens(service.handoff(idle.id, 'codex', '', false))).agent).toBe('codex')
    expect(daemon.killed).toEqual([{ sessionId: idle.sessionId, force: false }])

    daemon.reply = () => {}
    const working = await service.create('claude', [])
    await service.send(working.id, 'still going')
    await settle()
    await expect(service.handoff(working.id, 'codex', '', false)).rejects.toMatchObject({ reason: 'conversation-running' })
    const spawned = daemon.spawns.length
    expect((await service.continue(working.id)).sessionId).toBe(working.sessionId)
    expect(daemon.spawns).toHaveLength(spawned)
  })

  const task = { id: 'task-1', title: 'Chat me', agent: 'claude' as const }
  const exitPlanMode = (requestId: string) => ({
    type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: `toolu_${requestId}` }
  })

  const planRequest = { requestId: 'attention-plan', kind: 'approval', tool: 'ExitPlanMode', title: expect.any(String), decisions: expect.any(Array), open: 1 }

  it('lists task attention summaries before opening their chat and after a core restart', async () => {
    const started = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: true, session: 'new' })
    daemon.reply = () => {}
    await service.send(started.id, 'plan this')
    daemon.emit(started.sessionId!, exitPlanMode('attention-plan'))
    expect(service.list(true)).toEqual([expect.objectContaining({ id: started.id, taskId: task.id, chat: { turn: 'awaiting', request: planRequest } })])
    expect(service.list()).toEqual([])
    service = serve()
    await service.reconcile((await daemon.request('list', {})).sessions)
    expect(service.list(true)).toEqual([expect.objectContaining({ id: started.id, chat: { turn: 'awaiting', request: planRequest } })])
    daemon.exit(started.sessionId!, 1)
    expect(service.list(true)).toEqual([expect.objectContaining({ id: started.id, sessionId: null, lastExit: { code: 1, at: expect.any(Number) } })])
    service = serve()
    await service.reconcile((await daemon.request('list', {})).sessions)
    expect(service.list(true)[0]?.lastExit?.code).toBe(1)
  })

  it('starts a task\'s chat afresh in plan mode, then goes on with the same session in the same folder', async () => {
    const started = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new' })
    expect(started).toMatchObject({ taskId: 'task-1', title: 'Chat me', titleLocked: true, workspacePath: realpathSync(root) })
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
    await expect(service.continue(started.id)).rejects.toMatchObject({ reason: 'task-conversation' })
    await expect(service.handoff(started.id, 'codex', '', true)).rejects.toMatchObject({ reason: 'task-conversation' })
    await expect(service.delete(started.id)).rejects.toMatchObject({ reason: 'task-conversation' })
  })

  it('drops a previous reasoning override when the next task stage selects another model', async () => {
    const first = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new', model: 'sonnet', effort: 'high' })
    await service.stop(first.id)
    const next = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new', model: 'haiku' })
    expect(next.chatOptions).toMatchObject({ model: 'haiku', effort: null })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--model', 'haiku']))
    expect(daemon.spawns.at(-1)?.args).not.toContain('--effort')
  })

  it('can explicitly return a task stage to the agent and model defaults', async () => {
    const first = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new', model: 'sonnet', effort: 'high' })
    await service.stop(first.id)
    const next = await service.startForTask(task, { cwd: root, extraDirs: [], planOnly: false, session: 'new', model: null, effort: null })
    expect(next.chatOptions).toMatchObject({ model: null, effort: null })
    expect(daemon.spawns.at(-1)?.args).not.toContain('--model')
    expect(daemon.spawns.at(-1)?.args).not.toContain('--effort')
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
    const created = await service.create('claude', [app])
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
    const working = await service.create('claude', [root])
    await service.send(working.id, 'still going')
    await settle()
    await expect(service.setAdditionalProjects(working.id, [web])).rejects.toMatchObject({ reason: 'chat-busy' })
    const scratch = await service.create('claude', [])
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
    const created = await service.create('claude', [])
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
    const created = await service.create('claude', [])
    await expect(service.send(created.id, 'see', [`${'b'.repeat(64)}.png`])).rejects.toMatchObject({ reason: 'attachment-not-found' })
    const stored = await attachmentsAt(root).put(pngBytes(4, 3))
    await service.send(created.id, 'see', [stored.id, stored.id])
    await settle()
    expect(daemon.written(created.sessionId!).at(-1)).toMatchObject({ message: { content: [{ type: 'image' }, { type: 'text', text: 'see' }] } })
    expect(service.chatPage(created.id).items.find((item) => item.kind === 'user')).toMatchObject({ images: [{ id: stored.id, width: 4, height: 3 }] })
    expect(service.messages(created.id)[0]?.text).toBe('see\n\n（附了 1 张图片）')
  })

  describe('forking at a message', () => {
    const userTexts = (id: string) => service.chatPage(id).items.flatMap((item) => (item.kind === 'user' ? [item.text] : []))
    const stageOf = (id: string) => service.stages(id).at(-1)!

    async function twoTurns() {
      const source = await service.create('claude', [])
      await service.send(source.id, 'first')
      await settle()
      await service.send(source.id, 'second')
      await settle()
      return source
    }

    it("forks through an agent's reply: the chat to there, the session from there, the same folder", async () => {
      const source = await twoTurns()
      const stage = stageOf(source.id)
      const reply = service.chatPage(source.id).items.find((item) => item.kind === 'assistant' && item.text === 'echo: first')!
      const fork = await service.fork(source.id, stage.id, reply.id)
      expect(fork).toMatchObject({ agent: 'claude', forkedFromId: source.id, title: `${service.get(source.id).title} · 分支`, titleLocked: true, workspacePath: source.workspacePath })
      expect(fork.projectPaths).toEqual(source.projectPaths)
      const spawn = daemon.spawns.at(-1)!
      expect(spawn.cwd).toBe(source.workspacePath)
      expect(spawn.args).toEqual(expect.arrayContaining(['--resume', stage.providerSessionId, '--resume-session-at', 'uuid-first', '--fork-session']))
      expect(spawn.args).not.toContain('--session-id')
      // The copied chat ends with the first turn; the second never happened here.
      expect(userTexts(fork.id)).toEqual(['first'])
      expect(service.chatPage(fork.id).items.filter((item) => item.kind === 'turn')).toHaveLength(1)
      expect(store.messages(fork.id).map((message) => message.text)).toEqual(['first', 'echo: first'])
      expect(service.stages(fork.id)).toHaveLength(2)
      expect(service.stages(fork.id)[0]?.endedAt).not.toBeNull()
      // The source goes on untouched.
      expect(userTexts(source.id)).toEqual(['first', 'second'])
      expect(service.get(source.id).sessionId).not.toBeNull()
    })

    it('forks before a user message, leaving that message for the user to send', async () => {
      const source = await twoTurns()
      const stage = stageOf(source.id)
      const second = service.chatPage(source.id).items.find((item) => item.kind === 'user' && item.text === 'second')!
      const fork = await service.fork(source.id, stage.id, second.id)
      await settle()
      expect(daemon.spawns.at(-1)!.args).toEqual(expect.arrayContaining(['--resume-session-at', 'uuid-first', '--fork-session']))
      expect(userTexts(fork.id)).toEqual(['first'])
      expect(service.chatPage(fork.id).items.filter((item) => item.kind === 'assistant').map((item) => item.text)).toEqual(['echo: first'])
      expect(store.messages(fork.id).map((message) => message.text)).toEqual(['first', 'echo: first'])
      expect(service.get(fork.id).chat?.turn).toBe('idle')
    })

    it('forks before the first message afresh, with nothing to resume', async () => {
      const source = await twoTurns()
      const stage = stageOf(source.id)
      const first = service.chatPage(source.id).items.find((item) => item.kind === 'user' && item.text === 'first')!
      const fork = await service.fork(source.id, stage.id, first.id)
      await settle()
      const args = daemon.spawns.at(-1)!.args
      expect(args).toContain('--session-id')
      expect(args).not.toContain('--resume')
      expect(userTexts(fork.id)).toEqual([])
      expect(JSON.stringify(daemon.written(service.get(fork.id).sessionId ?? ''))).not.toContain('移交文件')
    })

    it('refuses a turn still going, a message it cannot find, and a task\'s conversation', async () => {
      const source = await service.create('claude', [])
      const stage = stageOf(source.id)
      daemon.reply = () => {}
      await service.send(source.id, 'slow')
      await settle()
      const slow = service.chatPage(source.id).items.find((item) => item.kind === 'user' && item.text === 'slow')!
      await expect(service.fork(source.id, stage.id, 'c:nothing:0')).rejects.toMatchObject({ reason: 'chat-item-not-found' })
      await expect(service.fork(source.id, randomUUID(), slow.id)).rejects.toMatchObject({ reason: 'stage-not-found' })
      // The user message itself can be forked before; nothing after it can.
      const fork = await service.fork(source.id, stage.id, slow.id)
      expect(userTexts(fork.id)).toEqual([])
      const task = store.create('claude', root, [root], randomUUID(), {}, { id: 'task-1', title: 'Dark mode' })
      await expect(service.fork(task.id, stage.id, slow.id)).rejects.toMatchObject({ reason: 'task-conversation' })
    })
  })

})
