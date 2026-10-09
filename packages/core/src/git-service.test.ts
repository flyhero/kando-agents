import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation, Task, type GitTarget } from '@kando/protocol'
import { GitService } from './git-service'
import { committedDiff, filesBetween } from './git-repository'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
describe('Git management', () => {
  let root: string
  let repo: string
  let remote: string
  let service: GitService
  let target: GitTarget
  let conversations: Conversation[]
  let tasks: Task[]
  let launching: boolean
  const record = vi.fn(async () => {})
  const commit = (name: string, content: string, message = name) => { writeFileSync(path.join(repo, name), content); git(repo, 'add', '--', name); git(repo, 'commit', '-q', '-m', message); return git(repo, 'rev-parse', 'HEAD') }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kando-git-management-')))
    repo = path.join(root, 'repo'); remote = path.join(root, 'origin.git')
    git(root, 'init', '-q', '--bare', '-b', 'main', remote)
    git(root, 'init', '-q', '-b', 'main', repo)
    git(repo, 'config', 'user.name', 'Kando Test'); git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'remote', 'add', 'origin', remote)
    commit('file.txt', 'base\n', 'initial')
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    conversations = [Conversation.parse({ id: randomUUID(), title: 'test', titleLocked: false, agent: 'claude', workspacePath: repo, projectPaths: [repo], managedWorkspace: false, sessionId: null, createdAt: 0, updatedAt: 0 })]
    tasks = []; launching = false; record.mockClear()
    service = new GitService({ get: (id) => { const task = tasks.find((task) => task.id === id); if (!task) throw new Error('task missing'); return task }, list: () => tasks, isLaunching: () => launching }, {
      get: (id) => { const conversation = conversations.find((conversation) => conversation.id === id); if (!conversation) throw new Error('conversation missing'); return conversation }, list: () => conversations, recordGitChange: record, isGitPending: () => false
    })
    target = { kind: 'conversation', id: conversations[0]!.id, project: repo }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('holds a repository lock across preparation or cleanup and blocks agent starts in subdirectories', async () => {
    const child = path.join(repo, 'child'); mkdirSync(child)
    let release = () => {}
    let started = () => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { started = resolve })
    const operation = service.withRepositories([repo], async () => { started(); await pending; return 'done' })
    await ready
    try {
      await expect(service.execute(target, { kind: 'fetch' })).rejects.toMatchObject({ reason: 'git-busy' })
      await expect(service.guardAgent([child])).rejects.toMatchObject({ reason: 'git-busy' })
      await expect(service.withRepositories([child], async () => {})).rejects.toMatchObject({ reason: 'git-busy' })
    } finally { release(); await operation }
    await expect(service.guardAgent([child])).resolves.toBeUndefined()
    await expect(service.execute(target, { kind: 'fetch' })).resolves.toEqual({ state: 'done' })
  })

  it('lists upstreams and worktree holders and protects task branches even after cleanup', async () => {
    const worktree = path.join(root, 'worktree')
    git(repo, 'worktree', 'add', '-q', '-b', 'kando/task', worktree)
    tasks.push(Task.parse({ id: 'task', title: 'task', details: '', status: 'done', repos: [{ path: repo, worktreePath: worktree, branch: 'kando/task' }], dependsOn: [], agent: 'claude', createdAt: 0, updatedAt: 0 }))
    expect(await service.status(target)).toMatchObject({ branch: 'main', upstream: 'origin/main', changes: 0 })
    expect((await service.status(target)).branches.find((branch) => branch.name === 'kando/task')).toMatchObject({ protected: true, worktree })
    await expect(service.execute(target, { kind: 'delete', ref: 'refs/heads/kando/task' })).rejects.toMatchObject({ reason: 'git-protected' })
    git(repo, 'worktree', 'remove', worktree); tasks[0]!.repos[0]!.worktreePath = null
    await expect(service.execute(target, { kind: 'rename', ref: 'refs/heads/kando/task', name: 'new' })).rejects.toMatchObject({ reason: 'git-protected' })
  })

  it('rejects foreign directories, busy or starting agents and task checkouts', async () => {
    await expect(service.status({ ...target, project: root })).rejects.toMatchObject({ reason: 'repo-not-found' })
    for (const turn of ['running', 'awaiting'] as const) {
      conversations[0]!.sessionId = 'agent'; conversations[0]!.chat = { turn }
      await expect(service.execute(target, { kind: 'fetch' })).rejects.toMatchObject({ reason: 'chat-busy' })
    }
    conversations[0]!.sessionId = null; conversations[0]!.starting = true
    await expect(service.execute(target, { kind: 'fetch' })).rejects.toMatchObject({ reason: 'chat-busy' })
    conversations[0]!.starting = false
    tasks.push(Task.parse({ id: 'task', title: '', details: '', status: 'running', repos: [{ path: repo, worktreePath: repo, branch: 'main' }], dependsOn: [], agent: 'claude', createdAt: 0, updatedAt: 0 }))
    const taskTarget: GitTarget = { kind: 'task', id: 'task', project: repo }
    await expect(service.execute(taskTarget, { kind: 'switch', ref: 'refs/remotes/origin/main' })).rejects.toMatchObject({ reason: 'task-conversation' })
    await service.execute(taskTarget, { kind: 'create', name: 'candidate', ref: 'HEAD', checkout: false })
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    launching = true
    await expect(service.execute(target, { kind: 'fetch' })).rejects.toMatchObject({ reason: 'chat-busy' })
  })

  it('creates tracking branches, refuses name collisions and never overwrites work', async () => {
    await service.execute(target, { kind: 'create', name: 'feature', ref: 'refs/remotes/origin/main', checkout: true })
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
    expect(record).toHaveBeenCalledWith(target.id, repo, 'feature', true)
    await expect(service.execute(target, { kind: 'create', name: 'feature', ref: 'HEAD', checkout: false })).rejects.toMatchObject({ reason: 'git-operation-failed' })
    await expect(service.execute(target, { kind: 'create', name: '-bad', ref: 'HEAD', checkout: false })).rejects.toMatchObject({ reason: 'invalid-branch-name' })
    writeFileSync(path.join(repo, 'file.txt'), 'unsaved')
    await expect(service.execute(target, { kind: 'switch', ref: 'refs/heads/main' })).rejects.toMatchObject({ reason: 'uncommitted-changes' })
    expect(git(repo, 'diff')).toContain('unsaved')
  })

  it('safely deletes merged branches and remote branches but refuses current and unmerged ones', async () => {
    git(repo, 'branch', 'merged')
    await service.execute(target, { kind: 'rename', ref: 'refs/heads/merged', name: 'renamed' })
    await service.execute(target, { kind: 'delete', ref: 'refs/heads/renamed' })
    await expect(service.execute(target, { kind: 'delete', ref: 'refs/heads/main' })).rejects.toMatchObject({ reason: 'branch-elsewhere' })
    git(repo, 'switch', '-q', '-c', 'unique'); commit('unique.txt', 'unique\n'); git(repo, 'switch', '-q', 'main')
    await expect(service.execute(target, { kind: 'delete', ref: 'refs/heads/unique' })).rejects.toMatchObject({ reason: 'git-operation-failed' })
    git(repo, 'push', '-q', 'origin', 'main:release'); git(repo, 'fetch', '-q')
    await service.execute(target, { kind: 'delete', ref: 'refs/remotes/origin/release' })
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'release')).toBe('')
  })

  it('handles root, rename, binary and unusual filenames in committed diffs', async () => {
    const initial = git(repo, 'rev-parse', 'HEAD')
    const detail = await service.detail(target, initial)
    expect(detail.parent).toBeNull(); expect(detail.files).toMatchObject([{ kind: 'added', path: 'file.txt', additions: 1 }])
    expect((await service.diff(target, null, initial, 'file.txt')).diff).toContain('+base')
    git(repo, 'mv', 'file.txt', 'with\tnewline\n.txt')
    writeFileSync(path.join(repo, 'binary.dat'), Buffer.from([0, 1, 2]))
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'rename and binary')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(await filesBetween(repo, initial, head)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'renamed', path: 'with\tnewline\n.txt', oldPath: 'file.txt' }), expect.objectContaining({ path: 'binary.dat', additions: null, deletions: null })
    ]))
    expect((await committedDiff(repo, initial, head, 'with\tnewline\n.txt')).diff).toContain('rename')
    await expect(service.diff(target, initial, head, '../outside')).rejects.toMatchObject({ reason: 'file-not-changed' })
    await expect(service.detail(target, '--all')).rejects.toMatchObject({ reason: 'branch-not-found' })
  })

  it('paginates on fixed tips while new commits arrive and searches across pages', async () => {
    for (let i = 0; i < 110; i++) git(repo, 'commit', '-q', '--allow-empty', '-m', `commit ${i}`)
    const first = await service.history(target, 'HEAD', 0, '')
    expect(first.commits).toHaveLength(100); expect(first.next).toBe(100)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'new tip')
    const second = await service.history(target, 'HEAD', first.next!, '', first.tips)
    expect(second.commits).toHaveLength(11); expect(second.next).toBeNull()
    expect(new Set([...first.commits, ...second.commits].map((commit) => commit.sha)).size).toBe(111)
    expect((await service.history(target, 'HEAD', 0, 'commit 0')).commits).toHaveLength(1)
    expect((await service.history(target, 'HEAD', 0, 'Kando Test')).commits).toHaveLength(100)
  })

  it('compares divergence, fast-forwards pull and refuses a divergent pull', async () => {
    const peer = path.join(root, 'peer')
    git(root, 'clone', '-q', remote, peer); git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@t')
    writeFileSync(path.join(peer, 'peer.txt'), 'peer'); git(peer, 'add', '.'); git(peer, 'commit', '-q', '-m', 'peer'); git(peer, 'push', '-q')
    await service.execute(target, { kind: 'pull' }); expect(git(repo, 'log', '-1', '--format=%s')).toBe('peer')
    commit('local.txt', 'local')
    writeFileSync(path.join(peer, 'peer.txt'), 'peer2'); git(peer, 'add', '.'); git(peer, 'commit', '-q', '-m', 'peer2'); git(peer, 'push', '-q')
    const before = git(repo, 'rev-parse', 'HEAD')
    await expect(service.execute(target, { kind: 'pull' })).rejects.toMatchObject({ reason: 'git-operation-failed' })
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    const comparison = await service.compare(target, 'refs/remotes/origin/main', false)
    expect(comparison).toMatchObject({ ahead: 1, behind: 1 }); expect(comparison.files.map((file) => file.path)).toEqual(['peer.txt'])
    expect((await service.compare(target, 'refs/remotes/origin/main', true)).files.map((file) => file.path)).toEqual(['local.txt', 'peer.txt'])
  })

  it('reads persisted merge conflicts and supports resolve, finish and abort', async () => {
    git(repo, 'switch', '-q', '-c', 'feature'); commit('file.txt', 'feature\n'); git(repo, 'switch', '-q', 'main'); commit('file.txt', 'main\n')
    expect(await service.execute(target, { kind: 'merge', ref: 'refs/heads/feature' })).toEqual({ state: 'conflicts' })
    expect(await service.status(target)).toMatchObject({ operation: 'merge', conflicts: ['file.txt'] })
    await expect(service.execute(target, { kind: 'continue' })).rejects.toMatchObject({ reason: 'git-conflicts' })
    await expect(service.execute(target, { kind: 'commit', message: 'wrong', push: false })).rejects.toMatchObject({ reason: 'git-in-progress' })
    await service.execute(target, { kind: 'abort' }); expect(await service.status(target)).toMatchObject({ operation: null, changes: 0 })
    await service.execute(target, { kind: 'merge', ref: 'refs/heads/feature' })
    writeFileSync(path.join(repo, 'file.txt'), 'resolved\n')
    await service.execute(target, { kind: 'resolve', file: 'file.txt' }); await service.execute(target, { kind: 'continue' })
    const detail = await service.detail(target, git(repo, 'rev-parse', 'HEAD'))
    expect(detail.commit.parents).toHaveLength(2)
    expect((await service.detail(target, detail.commit.sha, detail.commit.parents[1])).files).toMatchObject([{ path: 'file.txt' }])
    expect(await service.status(target)).toMatchObject({ operation: null, changes: 0 })
  })

  it('pushes new branches explicitly and retains a local commit if push fails', async () => {
    await service.execute(target, { kind: 'create', name: 'new', ref: 'HEAD', checkout: true })
    commit('new.txt', 'new')
    expect(await service.execute(target, { kind: 'push', remote: 'origin', name: 'new-remote' })).toMatchObject({ upstream: 'origin/new-remote' })
    writeFileSync(path.join(repo, 'new.txt'), 'changed')
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing'))
    await expect(service.execute(target, { kind: 'commit', message: 'keep me', push: true })).rejects.toMatchObject({ reason: 'git-push-after-commit-failed' })
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('keep me'); expect(git(repo, 'status', '--porcelain')).toBe('')
  })
})
