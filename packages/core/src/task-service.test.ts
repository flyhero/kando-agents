import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { AttachmentStore } from './attachment-store'
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
    list: () => ({ sessions: [] })
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

  it('runs a single repo inside its own worktree and finishes when the session exits', async () => {
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
    expect(service.get(task.id).status).toBe('done')
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

  it('lays several repos out side by side and tells the agent which is which', async () => {
    const api = initRepo('api')
    const web = initRepo('web')
    const task = readyTask('Rename user id', [api, web])

    const running = await service.run(task.id)
    const taskDir = path.join(dir, 'worktrees', task.id.slice(0, 8))
    expect(sessions.spawns[0]?.cwd).toBe(taskDir)
    expect(running.repos.map((repo) => repo.worktreePath)).toEqual([path.join(taskDir, 'api'), path.join(taskDir, 'web')])
    expect(git(path.join(taskDir, 'web'), 'branch', '--show-current')).toBe(running.repos[1]?.branch)
    expect(sessions.spawns[0]?.args[1]).toContain(`- api/ ← ${api}`)
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

  it('marks running tasks done when the daemon no longer has their session', async () => {
    const task = readyTask('Ghost', [dir])
    await service.run(task.id)

    service.reconcile([])
    expect(service.get(task.id).status).toBe('done')
  })

  it('continues a done task on its own worktree and branch', async () => {
    const task = readyTask('Retry', [initRepo('app')])
    const run = await service.run(task.id)
    service.handleSessionExit(run.sessionId ?? '', 0)
    await expect(service.run(task.id)).rejects.toMatchObject({ reason: 'not-pending' })

    const continued = await service.continue(task.id)
    expect(continued).toMatchObject({ status: 'running', repos: run.repos })
    expect(sessions.spawns[1]).toMatchObject({ cwd: run.repos[0]?.worktreePath })
    expect(sessions.spawns[1]?.args.at(-1)).toContain('这个任务之前已经执行过一次')
    service.handleSessionExit(continued.sessionId ?? '', 0)
    expect(service.get(task.id).status).toBe('done')
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
    expect(service.get(task.id)).toMatchObject({ status: 'done', lastExit: { code: 2 } })
    expect(await service.continue(task.id)).toMatchObject({ status: 'running', lastExit: null })
  })

  it('records an unknown exit for a run whose session is gone, and the code for one that exited', async () => {
    const lost = await service.run(readyTask('Lost', [initRepo('lost')]).id)
    const exited = await service.run(readyTask('Exited', [initRepo('exited')]).id)
    service.reconcile([{ sessionId: exited.sessionId ?? '', exited: true, exitCode: 1 }])
    expect(service.get(lost.id)).toMatchObject({ status: 'done', lastExit: { code: null } })
    expect(service.get(exited.id)).toMatchObject({ status: 'done', lastExit: { code: 1 } })
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
