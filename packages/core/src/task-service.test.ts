import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { fakeChatDaemon } from './fake-chat-agent'
import { gifBytes, pngBytes } from './image-fixtures'
import { ProjectRegistry } from './project-registry'
import { TaskService, type TaskEvent } from './task-service'
import { TaskStore } from './task-store'

type FakeHandlers = { [M in DaemonMethod]: (params: DaemonParams<M>) => DaemonResult<M> }

function fakeSessions(): SessionHost & { spawns: DaemonParams<'spawn'>[] } {
  const spawns: DaemonParams<'spawn'>[] = []
  const handlers: FakeHandlers = {
    spawn: (params) => {
      spawns.push(params)
      return { sessionId: `session-${spawns.length}` }
    },
    write: () => ({ ok: true }),
    resize: () => ({ ok: true }),
    kill: () => ({ ok: true }),
    attach: ({ sessionId }) => ({ sessionId, exited: false, exitCode: null, buffer: '', bufferStart: 0, endOffset: 0 }),
    list: () => ({ sessions: [] }),
    spawnPipe: () => { throw new Error('unused') },
    release: () => ({ ok: true })
  }
  return {
    spawns,
    request: async (method, params) => handlers[method](params),
    onEvent: () => () => {}
  }
}

describe('TaskService', () => {
  let dir: string
  let store: TaskStore
  let projects: ProjectRegistry
  let sessions: ReturnType<typeof fakeSessions>
  let events: TaskEvent[]
  let service: TaskService
  let attachments: AttachmentStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-test-'))
    store = new TaskStore(path.join(dir, 'kando.db'))
    projects = new ProjectRegistry(path.join(dir, 'kando.db'))
    sessions = fakeSessions()
    events = []
    attachments = new AttachmentStore(dir)
    service = new TaskService(
      store,
      projects,
      sessions,
      path.join(dir, 'worktrees'),
      (e) => events.push(e),
      (taskId) => ({ command: 'kando', args: ['mcp', '--task', taskId] }),
      attachments
    )
  })

  afterEach(() => {
    projects.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8'
    }).trim()
  }

  function initRepo(name: string): string {
    const repo = path.join(dir, name)
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    return repo
  }

  function readyTask(title: string, repos: string[]) {
    const task = service.create({ title })
    return service.update({ id: task.id, details: 'x', repos, agent: 'claude' })
  }

  it('creates pending tasks and keeps them pending while details are written', () => {
    const task = service.create({ title: 'Refactor login' })
    expect(task.status).toBe('pending')

    const updated = service.update({ id: task.id, details: 'Switch to OAuth device flow' })
    expect(updated.status).toBe('pending')
    expect(events.map((e) => e.type)).toEqual(['changed', 'changed'])
  })

  it('creates a task with repos, agent, dependencies and details in one call', () => {
    const base = service.create({ title: 'Base' })
    events = []
    const task = service.create({
      title: 'Full',
      details: 'x',
      repos: [dir, dir],
      dependsOn: [base.id.slice(0, 8)],
      agent: 'codex'
    })
    expect(task).toMatchObject({
      details: 'x',
      agent: 'codex',
      dependsOn: [base.id],
      repos: [{ path: dir, worktreePath: null, branch: null }]
    })
    expect(events).toHaveLength(1)
    expect(projects.recent()).toContain(dir)
  })

  it('creates nothing when a field is invalid', () => {
    expect(() => service.create({ title: 'Bad', repos: ['relative/path'] })).toThrow(/absolute/)
    expect(() => service.create({ title: 'Bad', dependsOn: ['ffffffff'] })).toThrow(/no task/)
    expect(service.list()).toEqual([])
  })

  it('resolves short id prefixes and rejects unknown ones', () => {
    const task = service.create({ title: 'A' })
    expect(service.get(task.id.slice(0, 8)).id).toBe(task.id)
    expect(() => service.get('ffffffff')).toThrow(/no task/)
  })

  it('runs a single repo inside its own worktree and waits for review when the session exits', async () => {
    const repo = initRepo('app')
    const task = service.create({ title: 'Add dark mode' })
    service.update({ id: task.id, details: 'Use CSS tokens', repos: [repo], agent: 'claude' })

    const running = await service.run(task.id)
    const short = task.id.slice(0, 8)
    expect(running.status).toBe('running')
    expect(running.repos).toEqual([
      { path: repo, worktreePath: path.join(dir, 'worktrees', short, 'app'), branch: `kando/${short}-add-dark-mode` }
    ])
    expect(sessions.spawns[0]).toMatchObject({
      command: 'claude',
      args: ['--', 'Add dark mode\n\nUse CSS tokens'],
      cwd: running.repos[0]?.worktreePath
    })

    service.handleSessionExit(running.sessionId ?? '', 0)
    expect(service.get(task.id).status).toBe('review')
    expect(service.move(task.id, 'done').status).toBe('done')
  })

  it('reads a run\'s changes from its worktree, and diffs only the task\'s own repos', async () => {
    const repo = initRepo('app')
    const task = readyTask('Add theme', [repo])
    expect((await service.changes(task.id))[0]).toMatchObject({ base: null, files: [] })
    const running = await service.run(task.id)
    writeFileSync(path.join(running.repos[0]!.worktreePath!, 'theme.css'), 'body {}\n')
    expect((await service.changes(task.id))[0]?.files).toEqual([
      { path: 'theme.css', oldPath: null, kind: 'untracked', additions: null, deletions: null }
    ])
    expect((await service.diff(task.id, repo, 'theme.css')).diff).toContain('+body {}')
    await expect(service.diff(task.id, dir, 'theme.css')).rejects.toMatchObject({ reason: 'repo-not-found' })
  })

  it('reads branches from the task\'s worktrees only, once a run has made them', async () => {
    const repo = initRepo('app')
    const task = readyTask('Add dark mode', [repo])
    expect(await service.branches(task.id)).toEqual([{ path: repo, branch: null, detached: false }])
    const running = await service.run(task.id)
    writeFileSync(path.join(running.repos[0]!.worktreePath!, 'theme.css'), '')
    expect(await service.branches(task.id)).toEqual([
      { path: repo, branch: running.repos[0]!.branch, detached: false, upstream: null, ahead: 0, behind: 0, changes: 1 }
    ])
  })

  it('attaches images in order, checks each file, and carries them into a redo', async () => {
    const first = await attachments.put(pngBytes(40, 30))
    const second = await attachments.put(gifBytes(8, 8))
    const task = await service.createTask({ title: 'Fix layout', images: [{ id: first.id, name: '登录页' }] })
    expect(task.images).toEqual([{ id: first.id, name: '登录页', width: 40, height: 30 }])

    const [a, b] = await Promise.all([
      service.addImages(task.id, [{ id: second.id, name: '' }]),
      service.addImages(task.id, [{ id: first.id, name: 'again' }])
    ])
    expect([a, b].map((each) => each.images.length)).toContain(2)
    expect(service.get(task.id).images.map((image) => image.id)).toEqual([first.id, second.id])
    await expect(service.addImages(task.id, [{ id: `${'c'.repeat(64)}.png`, name: '' }])).rejects.toMatchObject({
      reason: 'attachment-not-found'
    })
    await expect(service.createTask({ title: 'x', images: [{ id: `${'c'.repeat(64)}.png`, name: '' }] })).rejects.toMatchObject({
      reason: 'attachment-not-found'
    })
    expect(service.list().map((each) => each.title)).toEqual(['Fix layout'])

    expect(service.updateImage(task.id, second.id, ' 弹窗 ').images[1]?.name).toBe('弹窗')
    store.update(task.id, { status: 'done' })
    expect(service.redo(task.id, undefined).images.map((image) => image.name)).toEqual(['登录页', '弹窗'])
    expect(service.removeImage(task.id, first.id).images.map((image) => image.id)).toEqual([second.id])
  })

  it('points the agent at the images, the user\'s first and an issue\'s fenced off', async () => {
    const repo = initRepo('app')
    const mine = await attachments.put(pngBytes(40, 30))
    const theirs = await attachments.put(gifBytes(8, 8))
    const source = { provider: 'jira', instance: 'default', name: 'Jira', key: 'PROJ-7', url: 'https://acme.atlassian.net/browse/PROJ-7' }
    const snapshot = { markdown: '见截图', fetchedAt: 0, images: [{ id: theirs.id, name: 'shot.gif', width: 8, height: 8 }] }
    const task = service.importTask({ title: 'Fix', agent: 'claude', source, snapshot })
    await service.addImages(task.id, [{ id: mine.id, name: '登录页' }])
    service.update({ id: task.id, repos: [repo] })

    await service.run(task.id)
    const args = sessions.spawns[0]?.args ?? []
    const prompt = args.at(-1) ?? ''
    expect(prompt).toContain(`任务附了 1 张图片，开始前先用读取文件的工具查看（如果它们已经附在这条消息里，直接看即可）：\n- 图 1 登录页：${path.join(dir, mine.id)}`)
    expect(prompt).toMatch(new RegExp(`<untrusted-source[^>]*>[\\s\\S]*- shot.gif：${path.join(dir, theirs.id).replace(/[.]/g, '\\.')}[\\s\\S]*</untrusted-source>`))
    expect(args[1]).toBe(`Read(/${path.join(dir, mine.id)}),Read(/${path.join(dir, theirs.id)})`)
  })

  it('puts the issue key of an imported task into its branch, where Jira looks for it', async () => {
    const repo = initRepo('app')
    const source = { provider: 'jira', instance: 'default', name: 'Jira', key: 'PROJ-7', url: 'https://acme.atlassian.net/browse/PROJ-7' }
    const task = service.importTask({ title: '菜单分类排序', agent: 'claude', source, snapshot: { markdown: 'x', fetchedAt: 0, images: [] } })
    service.update({ id: task.id, repos: [repo] })

    const running = await service.run(task.id)
    expect(running.repos[0]?.branch).toBe(`kando/PROJ-7-${task.id.slice(0, 8)}`)
    expect(sessions.spawns[0]?.args[1]).toContain('这个任务来自 Jira PROJ-7')
  })

  it('runs in place for a plain folder workspace', async () => {
    const folder = path.join(dir, 'notes')
    mkdirSync(folder)
    const running = await service.run(readyTask('Tidy notes', [folder]).id)
    expect(running.repos[0]?.worktreePath).toBeNull()
    expect(sessions.spawns[0]?.cwd).toBe(folder)
  })

  it.each(['claude', 'codex'] as const)('runs %s in the primary worktree with isolated additional repos', async (agent) => {
    const api = initRepo('api')
    const web = initRepo('web')
    const task = readyTask('Rename user id', [api, web])
    service.update({ id: task.id, agent })

    const running = await service.run(task.id)
    const taskDir = path.join(dir, 'worktrees', task.id.slice(0, 8))
    expect(sessions.spawns[0]?.cwd).toBe(path.join(taskDir, 'api'))
    expect(running.repos.map((repo) => repo.worktreePath)).toEqual([path.join(taskDir, 'api'), path.join(taskDir, 'web')])
    expect(git(path.join(taskDir, 'web'), 'branch', '--show-current')).toBe(running.repos[1]?.branch)
    expect(sessions.spawns[0]?.args.slice(0, 2)).toEqual(['--add-dir', path.join(taskDir, 'web')])
    expect(sessions.spawns[0]?.args.at(-1)).toContain(`主项目：.（${path.join(taskDir, 'api')}） ← ${api}`)
    for (const repo of running.repos) {
      writeFileSync(path.join(repo.worktreePath!, 'draft.txt'), repo.path)
      expect(existsSync(path.join(repo.path, 'draft.txt'))).toBe(false)
      expect((await service.diff(task.id, repo.path, 'draft.txt')).diff).toContain(`+${repo.path}`)
    }
    expect((await service.changes(task.id)).map((repo) => repo.files.length)).toEqual([1, 1])
  })

  it('persists primary selection and reuses worktrees, branches and edits when continuing', async () => {
    const api = initRepo('api')
    const web = initRepo('web')
    const task = readyTask('Primary', [api, web])
    const running = await service.run(task.id)
    const original = running.repos
    writeFileSync(path.join(original[1]!.worktreePath!, 'draft.txt'), 'keep me')
    service.handleSessionExit(running.sessionId!, 0)
    const updated = service.update({ id: task.id, repos: [web, api] })
    expect(updated.repos).toEqual([original[1], original[0]])
    const reopened = new TaskStore(path.join(dir, 'kando.db'))
    try {
      expect(reopened.get(task.id)?.repos).toEqual(updated.repos)
    } finally {
      reopened.close()
    }
    const continued = await service.continue(task.id)
    expect(continued.repos).toEqual(updated.repos)
    expect(sessions.spawns[1]?.cwd).toBe(original[1]?.worktreePath)
    expect(sessions.spawns[1]?.args.slice(0, 2)).toEqual(['--add-dir', original[0]?.worktreePath])
    expect(readFileSync(path.join(original[1]!.worktreePath!, 'draft.txt'), 'utf8')).toBe('keep me')
    service.handleSessionExit(continued.sessionId!, 0)
    const redo = service.redo(task.id, undefined)
    expect(redo.repos.map((repo) => repo.path)).toEqual([web, api])
    const redone = await service.run(redo.id)
    expect(sessions.spawns[2]?.cwd).toBe(redone.repos[0]?.worktreePath)
    expect(redone.repos[0]?.worktreePath).not.toBe(original[1]?.worktreePath)
    expect(existsSync(path.join(redone.repos[0]!.worktreePath!, 'draft.txt'))).toBe(false)
    expect(readFileSync(path.join(original[1]!.worktreePath!, 'draft.txt'), 'utf8')).toBe('keep me')
  })

  it('promotes the next project when the primary is removed without deleting its worktree', async () => {
    const api = initRepo('api')
    const web = initRepo('web')
    const task = readyTask('Remove primary', [api, web])
    const running = await service.run(task.id)
    service.handleSessionExit(running.sessionId!, 0)
    const updated = service.update({ id: task.id, repos: [web] })
    expect(updated.repos).toEqual([running.repos[1]])
    await service.continue(task.id)
    expect(sessions.spawns[1]?.cwd).toBe(running.repos[1]?.worktreePath)
    expect(existsSync(running.repos[0]!.worktreePath!)).toBe(true)
  })

  it('reserves existing same-name worktrees when adding a new primary', async () => {
    for (const name of ['first', 'second', 'third']) mkdirSync(path.join(dir, name))
    const first = initRepo('first/app')
    const second = initRepo('second/app')
    const third = initRepo('third/app')
    const task = readyTask('Same names', [first, second])
    const running = await service.run(task.id)
    service.handleSessionExit(running.sessionId!, 0)
    service.update({ id: task.id, repos: [third, second, first] })
    const continued = await service.continue(task.id)
    expect(continued.repos.slice(1)).toEqual([running.repos[1], running.repos[0]])
    expect(new Set(continued.repos.map((repo) => repo.worktreePath)).size).toBe(3)
    expect(git(continued.repos[0]!.worktreePath!, 'rev-parse', '--git-common-dir')).toBe(git(third, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    expect(sessions.spawns[1]?.cwd).toBe(continued.repos[0]?.worktreePath)
  })

  it('rejects project edits throughout run, refine and continue preparation', async () => {
    const api = initRepo('api')
    const web = initRepo('web')
    const task = readyTask('Starting', [api, web])
    const running = service.run(task.id)
    expect(() => service.update({ id: task.id, repos: [web, api] })).toThrow(expect.objectContaining({ reason: 'run-in-progress' }))
    service.handleSessionExit((await running).sessionId!, 0)
    const continuing = service.continue(task.id)
    expect(() => service.update({ id: task.id, repos: [] })).toThrow(expect.objectContaining({ reason: 'run-in-progress' }))
    await continuing

    const pending = readyTask('Refining', [api, web])
    const refining = service.refine(pending.id)
    expect(() => service.update({ id: pending.id, repos: [web, api] })).toThrow(expect.objectContaining({ reason: 'run-in-progress' }))
    await refining
    expect(() => service.update({ id: pending.id, repos: [web, api] })).toThrow(expect.objectContaining({ reason: 'refining' }))
    service.handleSessionExit(service.get(pending.id).refineSessionId!, 0)
    expect(service.update({ id: pending.id, repos: [web, api] }).repos[0]?.path).toBe(web)
  })

  it('rejects changes to an abandoned task through the service', async () => {
    const task = readyTask('Abandoned', [initRepo('api')])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId!, 0)
    service.redo(task.id, undefined)
    expect(() => service.update({ id: task.id, repos: [] })).toThrow(expect.objectContaining({ reason: 'task-abandoned' }))
  })

  it('refuses a plain folder next to other repos', async () => {
    const folder = path.join(dir, 'notes')
    mkdirSync(folder)
    const task = readyTask('Mixed', [initRepo('api'), folder])
    await expect(service.run(task.id)).rejects.toMatchObject({ reason: 'repo-not-git' })
  })

  it('keeps repos fixed while the agent runs', async () => {
    const task = readyTask('Locked', [initRepo('api')])
    await service.run(task.id)
    expect(() => service.update({ id: task.id, repos: [] })).toThrow(expect.objectContaining({ reason: 'task-running' }))
  })

  it('sends running tasks to review when the daemon no longer has their session', async () => {
    const task = readyTask('Ghost', [dir])
    await service.run(task.id)

    service.reconcile([])
    expect(service.get(task.id).status).toBe('review')
  })

  it('continues a finished task on its own worktree and branch', async () => {
    const task = readyTask('Retry', [initRepo('app')])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 0)
    await expect(service.run(task.id)).rejects.toMatchObject({ reason: 'not-pending' })

    const continued = await service.continue(task.id)
    expect(continued).toMatchObject({ status: 'running', repos: run.repos })
    expect(sessions.spawns[1]).toMatchObject({ cwd: run.repos[0]?.worktreePath })
    expect(sessions.spawns[1]?.args.at(-1)).toContain('这个任务之前已经执行过一次')
    service.handleSessionExit(continued.sessionId ?? '', 0)
    expect(service.get(task.id).status).toBe('review')
  })

  it('hands what the review found wrong to the continuing agent', async () => {
    const task = readyTask('Retry', [initRepo('app')])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 0)

    await service.continue(task.id, '登录后没有跳回原页面')
    const prompt = sessions.spawns[1]?.args.at(-1) ?? ''
    expect(prompt).toContain('验收时发现要改的地方：\n登录后没有跳回原页面')
    expect(prompt).toContain('然后按这些意见修改')
    expect(prompt).not.toContain('等我告诉你接下来要改什么')
  })

  it('redoes a done task as a fresh pending one and moves its dependents over', async () => {
    const repo = initRepo('app')
    const task = readyTask('Attempt', [repo])
    const dependent = service.update({ id: service.create({ title: 'Later' }).id, dependsOn: [task.id] })
    expect(() => service.redo(task.id, undefined)).toThrow(expect.objectContaining({ reason: 'not-done' }))

    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 0)
    // Dependencies are inherited too; added after the run so it was not blocked.
    const base = service.create({ title: 'Base' })
    service.update({ id: task.id, dependsOn: [base.id] })
    const successor = service.redo(task.id, '方向错了')

    expect(service.get(task.id)).toMatchObject({ status: 'abandoned', abandonReason: '方向错了', repos: run.repos })
    expect(successor).toMatchObject({
      status: 'pending',
      title: 'Attempt',
      details: 'x',
      agent: 'claude',
      dependsOn: [base.id],
      derivedFrom: task.id,
      repos: [{ path: repo, worktreePath: null, branch: null }]
    })
    expect(service.get(dependent.id).dependsOn).toEqual([successor.id])
    expect(() => service.move(task.id, 'pending')).toThrow(expect.objectContaining({ reason: 'invalid-transition' }))
  })

  it('runs a redo on a new branch and tells the agent about the abandoned attempt', async () => {
    const repo = initRepo('app')
    const task = readyTask('Attempt', [repo])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 0)
    const successor = service.redo(task.id, '')

    const redone = await service.run(successor.id)
    expect(redone.repos[0]?.branch).not.toBe(run.repos[0]?.branch)
    expect(sessions.spawns[1]?.args.at(-1)).toContain(`上一次尝试 ${task.id.slice(0, 8)}「Attempt」已废弃。`)
    expect(service.get(task.id).abandonReason).toBeNull()
  })

  it('waits for dependencies, then starts from the branch they left behind', async () => {
    const repo = initRepo('app')
    const first = readyTask('Add api', [repo])
    const second = service.update({ id: readyTask('Use api', [repo]).id, dependsOn: [first.id.slice(0, 8)] })
    expect(second.dependsOn).toEqual([first.id])
    await expect(service.run(second.id)).rejects.toMatchObject({ reason: 'blocked' })

    const firstRun = await service.run(first.id)
    const firstRepo = firstRun.repos[0]
    git(firstRepo?.worktreePath ?? '', 'commit', '-q', '--allow-empty', '-m', 'api from first')
    service.handleSessionExit(firstRun.sessionId ?? '', 0)
    // Under review the first task may still have failed; only accepting it lets the second go.
    await expect(service.run(second.id)).rejects.toMatchObject({ reason: 'blocked' })
    service.move(first.id, 'done')

    const secondRun = await service.run(second.id)
    expect(git(secondRun.repos[0]?.worktreePath ?? '', 'log', '--format=%s')).toContain('api from first')
    expect(sessions.spawns[1]?.args[1]).toContain(`${firstRepo?.branch}，本任务的分支从它拉出`)
  })

  it('starts from HEAD when several dependencies left branches in the same repo', async () => {
    const repo = initRepo('app')
    const done = async (title: string) => {
      const task = readyTask(title, [repo])
      const run = await service.run(task.id)
      git(run.repos[0]?.worktreePath ?? '', 'commit', '-q', '--allow-empty', '-m', `from ${title}`)
      service.handleSessionExit(run.sessionId ?? '', 0)
      service.move(task.id, 'done')
      return run
    }
    const first = await done('first')
    const second = await done('second')
    const task = service.update({ id: readyTask('both', [repo]).id, dependsOn: [first.id, second.id] })

    const run = await service.run(task.id)
    const log = git(run.repos[0]?.worktreePath ?? '', 'log', '--format=%s')
    expect(log).not.toContain('from first')
    expect(log).not.toContain('from second')
    const prompt = sessions.spawns.at(-1)?.args[1] ?? ''
    expect(prompt).toContain(first.repos[0]?.branch)
    expect(prompt).toContain(second.repos[0]?.branch)
    expect(prompt).not.toContain('本任务的分支从它拉出')
  })

  it('rejects dependency loops, including on itself', () => {
    const a = service.create({ title: 'A' })
    const b = service.create({ title: 'B' })
    service.update({ id: b.id, dependsOn: [a.id] })
    expect(() => service.update({ id: a.id, dependsOn: [b.id] })).toThrow(
      expect.objectContaining({ reason: 'dependency-cycle' })
    )
    expect(() => service.update({ id: a.id, dependsOn: [a.id] })).toThrow(
      expect.objectContaining({ reason: 'dependency-cycle' })
    )
  })

  it('drops a deleted task from its dependents and tells clients', async () => {
    const a = service.create({ title: 'A' })
    const b = service.update({ id: service.create({ title: 'B' }).id, dependsOn: [a.id] })
    events = []
    await service.delete(a.id)
    expect(service.get(b.id).dependsOn).toEqual([])
    expect(events).toEqual([
      { type: 'deleted', id: a.id },
      { type: 'changed', task: service.get(b.id) }
    ])
  })

  it('remembers projects added to any task, even after the task is gone', async () => {
    const task = service.create({ title: 'A' })
    service.update({ id: task.id, repos: [dir] })
    await service.delete(task.id)
    expect(projects.recent()).toEqual([dir])
  })

  it('refines read-only in the repo itself, creating no worktree or branch', async () => {
    const repo = initRepo('app')
    const task = readyTask('Tidy auth', [repo])

    const refining = await service.refine(task.id)
    expect(refining).toMatchObject({ status: 'pending', refineSessionId: 'session-1' })
    expect(refining.repos).toEqual([{ path: repo, worktreePath: null, branch: null }])
    expect(git(repo, 'branch', '--list', 'kando/*')).toBe('')
    const spawn = sessions.spawns[0]
    expect(spawn?.cwd).toBe(repo)
    expect(spawn?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit']))
    expect(spawn?.args).toContain(JSON.stringify({ mcpServers: { kando: { type: 'stdio', command: 'kando', args: ['mcp', '--task', task.id] } } }))
    expect(spawn?.args.at(-1)).toContain('propose_task_details')

    // One agent per task: no run and no second refine while this one is open.
    await expect(service.run(task.id)).rejects.toMatchObject({ reason: 'refining' })
    await expect(service.refine(task.id)).rejects.toMatchObject({ reason: 'refine-in-progress' })

    service.handleSessionExit('session-1', 0)
    expect(service.get(task.id)).toMatchObject({ status: 'pending', refineSessionId: null })
  })

  it('reads the other repos of a multi-repo task through --add-dir', async () => {
    const api = initRepo('api')
    const web = initRepo('web')
    await service.refine(readyTask('Rename id', [api, web]).id)
    expect(sessions.spawns[0]?.cwd).toBe(api)
    expect(sessions.spawns[0]?.args.slice(0, 2)).toEqual(['--add-dir', web])
  })

  it('tells whether a finished dependency has landed in the code being refined', async () => {
    const repo = initRepo('app')
    const first = readyTask('Add api', [repo])
    const firstRun = await service.run(first.id)
    git(firstRun.repos[0]?.worktreePath ?? '', 'commit', '-q', '--allow-empty', '-m', 'api')
    service.handleSessionExit(firstRun.sessionId ?? '', 0)
    const second = service.update({ id: readyTask('Use api', [repo]).id, dependsOn: [first.id] })

    await service.refine(second.id)
    expect(sessions.spawns.at(-1)?.args.at(-1)).toContain('已执行但还没验收，结果可能还要改')
    expect(sessions.spawns.at(-1)?.args.at(-1)).toContain('上的改动还没进当前代码')
    service.handleSessionExit(service.get(second.id).refineSessionId ?? '', 0)

    git(repo, 'merge', '-q', '--ff-only', firstRun.repos[0]?.branch ?? '')
    await service.refine(second.id)
    expect(sessions.spawns.at(-1)?.args.at(-1)).toContain('改动已在当前代码里')
  })

  it('refines Codex inside its read-only sandbox', async () => {
    const task = service.create({ title: 'Plan', repos: [dir], agent: 'codex' })
    await service.refine(task.id)
    expect(sessions.spawns[0]?.args.slice(0, 2)).toEqual(['--sandbox', 'read-only'])
  })

  it('clears a refining session the daemon no longer has', async () => {
    const task = service.create({ title: 'Plan', repos: [dir], agent: 'claude' })
    await service.refine(task.id)
    service.reconcile([])
    expect(service.get(task.id).refineSessionId).toBeNull()
  })

  it('keeps only the newest proposal and lets the user replace, append or drop it', () => {
    const task = service.create({ title: 'Plan', details: 'rough idea' })
    service.propose(task.id, 'first draft')
    expect(service.propose(task.id, 'second draft').proposal?.markdown).toBe('second draft')

    const appended = service.resolveProposal(task.id, 'append')
    expect(appended).toMatchObject({ details: 'rough idea\n\nsecond draft', proposal: null, previousDetails: 'rough idea' })

    service.propose(task.id, 'final plan')
    const replaced = service.resolveProposal(task.id, 'replace')
    expect(replaced).toMatchObject({ details: 'final plan', previousDetails: 'rough idea\n\nsecond draft' })

    service.propose(task.id, 'ignored')
    expect(service.resolveProposal(task.id, 'discard')).toMatchObject({ details: 'final plan', proposal: null })
    expect(() => service.resolveProposal(task.id, 'discard')).toThrow(expect.objectContaining({ reason: 'no-proposal' }))
  })

  it('undoes an accepted proposal until the details are edited again', () => {
    const task = service.create({ title: 'Plan', details: 'mine' })
    service.propose(task.id, 'theirs')
    service.resolveProposal(task.id, 'replace')
    expect(service.restoreDetails(task.id)).toMatchObject({ details: 'mine', previousDetails: null })

    service.propose(task.id, 'theirs')
    service.resolveProposal(task.id, 'replace')
    service.update({ id: task.id, details: 'theirs, tweaked' })
    expect(() => service.restoreDetails(task.id)).toThrow(expect.objectContaining({ reason: 'nothing-to-restore' }))
  })

  it('keeps how the last run ended, and clears it when the task runs again', async () => {
    const task = readyTask('Exit', [initRepo('exit')])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 2)
    expect(service.get(task.id)).toMatchObject({ status: 'review', lastExit: { code: 2 } })
    expect(await service.continue(task.id)).toMatchObject({ status: 'running', lastExit: null })
  })

  it('records an unknown exit for a run whose session is gone, and the code for one that exited', async () => {
    const lost = await service.run(readyTask('Lost', [initRepo('lost')]).id)
    const exited = await service.run(readyTask('Exited', [initRepo('exited')]).id)
    service.reconcile([{ sessionId: exited.sessionId ?? '', exited: true, exitCode: 1 }])
    expect(service.get(lost.id)).toMatchObject({ status: 'review', lastExit: { code: null } })
    expect(service.get(exited.id)).toMatchObject({ status: 'review', lastExit: { code: 1 } })
  })

  it('tracks when the agent waits for the user, but only while its session is open', async () => {
    const task = readyTask('Wait', [initRepo('wait')])
    const run = await service.run(task.id)
    service.agentEvent(task.id, 'run', true)
    expect(service.get(task.id).awaitingInput).toBe(true)
    service.noteInput(run.sessionId ?? '')
    expect(service.get(task.id).awaitingInput).toBe(false)

    service.agentEvent(task.id, 'run', true)
    service.handleSessionExit(run.sessionId ?? '', 0)
    expect(service.get(task.id).awaitingInput).toBe(false)
    service.agentEvent(task.id, 'run', true)
    service.agentEvent(task.id, 'refine', true)
    expect(service.get(task.id).awaitingInput).toBe(false)
  })

  it('gives both agents hooks that report their turns back', async () => {
    const reporting = new TaskService(
      store,
      projects,
      sessions,
      path.join(dir, 'worktrees'),
      () => {},
      (taskId) => ({ command: 'kando', args: ['mcp', '--task', taskId] }),
      attachments,
      (taskId, session, agent) => ['kando', 'task-event', taskId, session, agent]
    )
    const claude = reporting.update({ id: reporting.create({ title: 'Hooks' }).id, repos: [initRepo('hooks')], agent: 'claude' })
    await reporting.run(claude.id)
    const claudeArgs = sessions.spawns.at(-1)?.args ?? []
    const settings = JSON.parse(claudeArgs[claudeArgs.indexOf('--settings') + 1] ?? '{}')
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'])
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'kando', args: ['task-event', claude.id, 'run', 'claude'] })

    const codex = reporting.update({ id: reporting.create({ title: 'Notify' }).id, repos: [initRepo('notify')], agent: 'codex' })
    await reporting.refine(codex.id)
    expect(sessions.spawns.at(-1)?.args).toEqual(
      expect.arrayContaining(['-c', `notify=${JSON.stringify(['kando', 'task-event', codex.id, 'refine', 'codex'])}`])
    )
  })
})

describe('TaskService in the chat view', () => {
  let dir: string
  let store: TaskStore
  let conversationsStore: ConversationStore
  let projects: ProjectRegistry
  let attachments: AttachmentStore
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let service: TaskService
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  // Wired as main.ts wires them: the conversation service runs chat tasks and reports back.
  function serve(): void {
    conversations = new ConversationService(conversationsStore, daemon, path.join(dir, 'sessions'),
      (id, stage, agent) => ['node', 'callback.js', id, stage, agent],
      (event) => {
        if (event.type === 'changed') service.chatChanged(event.conversation)
        else if (event.type === 'planApproved') service.recordPlan(event.taskId, event.plan)
      },
      projects, attachments)
    const target = conversations
    daemon.deliver = (event) => {
      if (event.event === 'data') target.handleData(event)
      else if (event.event === 'exit') target.handleExit(event.sessionId, event.exitCode)
      else target.handleStderr(event.sessionId, event.data)
    }
    service = new TaskService(store, projects, daemon, path.join(dir, 'worktrees'), () => {},
      (taskId) => ({ command: 'kando', args: ['mcp', '--task', taskId] }), attachments, null, conversations)
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-task-chat-'))
    const database = path.join(dir, 'kando.db')
    store = new TaskStore(database)
    conversationsStore = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    attachments = new AttachmentStore(path.join(dir, 'attachments'))
    daemon = fakeChatDaemon()
    serve()
  })

  afterEach(() => {
    projects.close()
    conversationsStore.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  }

  function readyTask(title: string, repo: string) {
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    const task = service.create({ title })
    return service.update({ id: task.id, details: 'x', repos: [repo], agent: 'claude' })
  }

  const exitPlanMode = (requestId: string) => ({
    type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: `toolu_${requestId}` }
  })
  const sessionOf = (taskId: string) => conversations.get(service.get(taskId).conversationId ?? '').sessionId ?? ''
  const sentTo = (taskId: string) => JSON.stringify(daemon.written(sessionOf(taskId)))

  it('starts a runnable task in its worktree, planning first, and keeps the plan it approves', async () => {
    const task = readyTask('Chat me', path.join(dir, 'app'))
    const started = await service.start(task.id)
    expect(started).toMatchObject({ status: 'running', sessionId: null })
    const worktree = started.repos[0]?.worktreePath ?? ''
    expect(worktree).not.toBe('')
    expect(daemon.spawns.at(-1)).toMatchObject({ command: 'claude', cwd: realpathSync(worktree) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
    expect(sentTo(task.id)).toContain('然后给出实现计划')
    expect(conversations.list()).toEqual([])

    daemon.emit(sessionOf(task.id), exitPlanMode('plan-1'))
    await settle()
    await conversations.respond(started.conversationId ?? '', 'plan-1', { decision: 'allowForSession' })
    expect(service.get(task.id).plan).toMatchObject({ markdown: '# Plan', agent: 'claude', approved: true, requestId: 'plan-1' })
  })

  it('takes a task by the id prefix the CLI names it by', async () => {
    const task = readyTask('Chat me', path.join(dir, 'app'))
    const prefix = task.id.slice(0, 8)
    const started = await service.start(prefix)
    expect(started.repos[0]?.worktreePath).toBeTruthy()
    expect(conversations.get(started.conversationId ?? '').taskId).toBe(task.id)
    await settle()
    expect(service.submit(prefix).status).toBe('review')
    expect((await service.resumeChat(prefix)).status).toBe('running')
  })

  it('works in the primary project and reaches the others as additional directories', async () => {
    const api = path.join(dir, 'api')
    const web = path.join(dir, 'web')
    const dependency = readyTask('First', api)
    execFileSync('git', ['init', '-q', web])
    git(web, 'commit', '-q', '--allow-empty', '-m', 'init')
    const created = service.create({ title: 'Both' })
    const task = service.update({ id: created.id, details: 'x', repos: [web, api], agent: 'claude', dependsOn: [dependency.id] })

    // Planning reads the projects where they are, the primary one as the cwd.
    await service.start(task.id)
    expect(daemon.spawns.at(-1)).toMatchObject({ cwd: realpathSync(web) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--add-dir', realpathSync(api)]))

    store.update(dependency.id, { status: 'done' })
    const running = await service.start(task.id)
    const [primary, additional] = running.repos.map((repo) => realpathSync(repo.worktreePath ?? ''))
    expect(daemon.spawns.at(-1)).toMatchObject({ cwd: primary })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--add-dir', additional]))
    expect(conversations.get(running.conversationId ?? '').projectPaths).toEqual([primary, additional])
  })

  it('keeps a chat task\'s primary project and lets its agent take the projects added meanwhile', async () => {
    const api = path.join(dir, 'api')
    const web = path.join(dir, 'web')
    const dependency = readyTask('First', api)
    execFileSync('git', ['init', '-q', web])
    git(web, 'commit', '-q', '--allow-empty', '-m', 'init')
    const created = service.create({ title: 'Both' })
    const task = service.update({ id: created.id, details: 'x', repos: [api], agent: 'claude', dependsOn: [dependency.id] })
    await service.start(task.id)
    await settle()
    const spawned = daemon.spawns.length

    expect(() => service.update({ id: task.id, repos: [web, api] })).toThrow(expect.objectContaining({ reason: 'primary-fixed' }))
    expect(() => service.update({ id: task.id, repos: [] })).toThrow(expect.objectContaining({ reason: 'primary-fixed' }))
    // An additional project reaches the agent with the next message.
    service.update({ id: task.id, repos: [api, web] })
    await service.resumeChat(task.id)
    expect(daemon.spawns).toHaveLength(spawned + 1)
    expect(daemon.spawns.at(-1)).toMatchObject({ cwd: realpathSync(api) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--add-dir', realpathSync(web)]))
    // Nothing changed since: the agent is kept.
    await service.resumeChat(task.id)
    expect(daemon.spawns).toHaveLength(spawned + 1)
  })


  it('keeps a chat task running when its agent goes, hands it in when the user says, and goes on by message', async () => {
    const task = readyTask('Chat me', path.join(dir, 'app'))
    const started = await service.start(task.id)
    await settle()
    // The first turn is over: the agent waits on the user.
    expect(service.get(task.id).awaitingInput).toBe(true)
    daemon.exit(sessionOf(task.id), 0)
    await settle()
    service.reconcile([])
    expect(service.get(task.id)).toMatchObject({ status: 'running', awaitingInput: true })

    const resumed = await service.resumeChat(task.id)
    expect(resumed.status).toBe('running')
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--resume']))
    daemon.reply = () => {}
    await conversations.send(started.conversationId ?? '', 'still going')
    await settle()
    expect(() => service.submit(task.id)).toThrow(expect.objectContaining({ reason: 'agent-working' }))
    daemon.exit(sessionOf(task.id), 0)
    await settle()
    expect(service.submit(task.id).status).toBe('review')

    // Going on from review lays out a worktree the user removed and reopens the task.
    const worktree = service.get(task.id).repos[0]?.worktreePath ?? ''
    git(path.join(dir, 'app'), 'worktree', 'remove', '--force', worktree)
    const reopened = await service.resumeChat(task.id)
    expect(reopened.status).toBe('running')
    expect(existsSync(worktree)).toBe(true)
  })

  it('only plans while a dependency is unfinished, keeps the plan, and carries it out once it is done', async () => {
    const repo = path.join(dir, 'app')
    const dependency = readyTask('First', repo)
    const second = service.create({ title: 'Second' })
    const task = service.update({ id: second.id, details: 'x', repos: [repo], agent: 'claude', dependsOn: [dependency.id] })
    const planning = await service.start(task.id)
    expect(planning).toMatchObject({ status: 'pending', repos: [{ worktreePath: null, branch: null }] })
    expect(git(repo, 'branch', '--list', 'kando/*')).toBe('')
    expect(daemon.spawns.at(-1)).toMatchObject({ cwd: realpathSync(repo) })
    expect(daemon.spawns.at(-1)?.args).toEqual(expect.arrayContaining(['--disallowedTools']))
    expect(sentTo(task.id)).toContain('这次只读代码、讨论和规划')
    await expect(service.start(task.id)).rejects.toMatchObject({ reason: 'planning' })
    await expect(service.run(task.id)).rejects.toMatchObject({ reason: 'chat-task' })

    daemon.emit(sessionOf(task.id), exitPlanMode('plan-1'))
    await settle()
    const [stage] = conversations.stages(planning.conversationId ?? '')
    const saved = await service.savePlan(task.id, stage?.id ?? '', 'plan-1')
    expect(saved.plan).toMatchObject({ markdown: '# Plan', approved: false, stageId: stage?.id })

    store.update(dependency.id, { status: 'done' })
    const running = await service.start(task.id)
    expect(running.status).toBe('running')
    expect(running.repos[0]?.worktreePath).toBeTruthy()
    const args = daemon.spawns.at(-1)?.args ?? []
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--disallowedTools')
    expect(sentTo(task.id)).toContain('<saved-plan>')
  })

  it('goes on from review with a note, redoes without the chat, and deletes the chat with its task', async () => {
    const task = readyTask('Chat me', path.join(dir, 'app'))
    const started = await service.start(task.id)
    await settle()
    service.submit(task.id)
    const continued = await service.continue(task.id, 'rename the button')
    expect(continued.status).toBe('running')
    expect(sentTo(task.id)).toContain('rename the button')
    await settle()
    service.submit(task.id)
    const successor = service.redo(task.id, 'wrong approach')
    expect(successor.conversationId).toBeNull()
    await settle()
    await service.delete(task.id)
    expect(() => conversations.get(started.conversationId ?? '')).toThrow(expect.objectContaining({ reason: 'conversation-not-found' }))
    expect(existsSync(started.repos[0]?.worktreePath ?? '')).toBe(true)
  })
})
