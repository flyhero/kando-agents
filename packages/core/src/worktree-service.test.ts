import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Task, type TaskStatus } from '@kando/protocol'
import { WorktreeService, type WorktreeTasks } from './worktree-service'

describe('WorktreeService', () => {
  let dir: string
  let root: string
  let app: string
  let tasks: Task[]
  let released: string[]
  let forgotten: string[]
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const id = (prefix: string) => `${prefix.padEnd(8, '0')}-0000-4000-8000-000000000000`
  // A worktree where Kando lays one out, on a branch or, for planning, at a commit with none.
  const worktree = (prefix: string, { planning = false } = {}) => {
    const at = planning ? path.join(root, id(prefix).slice(0, 8), '.planning', 'app') : path.join(root, id(prefix).slice(0, 8), 'app')
    if (planning) git(app, 'worktree', 'add', '-q', '--detach', at, 'origin/main')
    else git(app, 'worktree', 'add', '-q', '--no-track', '-b', `kando/${prefix}`, at, 'origin/main')
    return at
  }
  const task = (prefix: string, status: TaskStatus, worktreePath: string | null) => {
    const made = Task.parse({
      id: id(prefix), title: prefix, details: '', status, dependsOn: [], agent: 'claude', sessionId: null, createdAt: 0, updatedAt: 0,
      repos: [{ path: app, worktreePath, branch: worktreePath ? `kando/${prefix}` : null }]
    })
    tasks.push(made)
    return made
  }
  let busy: Set<string>
  const hooks: WorktreeTasks = {
    list: () => tasks,
    inUse: async () => busy,
    releaseAgent: async (taskId) => {
      released.push(taskId)
    },
    forgetWorktree: (_taskId, worktreePath) => {
      forgotten.push(worktreePath)
    }
  }
  // Each counts its own notices: a count a finished test left running must not land in the next.
  const counted = () => {
    let changes = 0
    return { worktrees: new WorktreeService(root, hooks, () => changes++), changes: () => changes }
  }
  const service = () => counted().worktrees

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-worktrees-'))
    root = path.join(dir, 'worktrees')
    const origin = path.join(dir, 'origin.git')
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
    const seed = path.join(dir, 'seed')
    git(dir, 'init', '-q', '-b', 'main', seed)
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(seed, 'push', '-q', origin, 'main')
    app = path.join(dir, 'app')
    git(dir, 'clone', '-q', origin, app)
    tasks = []
    released = []
    forgotten = []
    busy = new Set()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists every worktree Kando laid out, with its task and what git says of it', async () => {
    const done = worktree('d')
    git(done, 'commit', '-q', '--allow-empty', '-m', 'work')
    task('d', 'done', done)
    const review = worktree('r')
    writeFileSync(path.join(review, 'new.txt'), 'x')
    task('r', 'review', review)
    const orphan = worktree('e')
    const planning = worktree('p', { planning: true })
    task('p', 'pending', null)
    const alone = worktree('a', { planning: true })
    git(alone, 'commit', '-q', '--allow-empty', '-m', 'only here')
    const locked = worktree('l')
    git(app, 'worktree', 'lock', locked)
    task('l', 'done', locked)
    busy.add(id('l'))

    const listed = new Map((await service().list()).map((each) => [each.path, each]))
    expect([...listed.keys()].sort()).toEqual([done, review, orphan, planning, alone, locked].sort())
    expect(listed.get(done)).toMatchObject({
      repo: realpathSync(app), branch: 'kando/d', taskId: id('d'), planning: false, changes: 0,
      unmerged: { count: 1, into: 'origin/main' }, alone: false, locked: false, size: null
    })
    expect(listed.get(review)).toMatchObject({ taskId: id('r'), changes: 1, unmerged: { count: 0, into: 'origin/main' } })
    expect(listed.get(orphan)).toMatchObject({ taskId: null, branch: 'kando/e', changes: 0 })
    expect(listed.get(planning)).toMatchObject({ taskId: id('p'), planning: true, branch: null, alone: false })
    expect(listed.get(alone)).toMatchObject({ taskId: null, planning: true, alone: true })
    expect(listed.get(locked)).toMatchObject({ locked: true, inUse: true })
    expect(listed.get(done)?.inUse).toBe(false)
  })

  it('counts sizes in the background and says when they are in', async () => {
    const done = worktree('d')
    writeFileSync(path.join(done, 'big.bin'), Buffer.alloc(64 * 1024))
    const { worktrees, changes } = counted()
    expect((await worktrees.list())[0]?.size).toBeNull()
    await expect.poll(changes).toBe(1)
    expect((await worktrees.list())[0]?.size).toBeGreaterThanOrEqual(64 * 1024)
    // Nothing was stale, so no second count, and no second word.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(changes()).toBe(1)
  })

  it('cleans what loses nothing, keeping branches, and says why it kept the rest', async () => {
    const done = worktree('d')
    git(done, 'commit', '-q', '--allow-empty', '-m', 'work')
    task('d', 'done', done)
    const orphan = worktree('e')
    const dirty = worktree('x')
    writeFileSync(path.join(dirty, 'draft.md'), 'x')
    task('x', 'done', dirty)
    const review = worktree('r')
    task('r', 'review', review)
    const alone = worktree('a', { planning: true })
    git(alone, 'commit', '-q', '--allow-empty', '-m', 'only here')
    const locked = worktree('l')
    git(app, 'worktree', 'lock', locked)
    const outside = path.join(dir, 'app')

    const { worktrees, changes } = counted()
    const results = await worktrees.clean([done, orphan, dirty, review, alone, locked, outside])
    expect(results.map((result) => [result.path, result.removed, result.reason])).toEqual([
      [done, true, null],
      [orphan, true, null],
      [dirty, false, 'worktree-dirty'],
      [review, false, 'task-active'],
      [alone, false, 'worktree-alone'],
      [locked, false, 'worktree-locked'],
      [outside, false, 'worktree-not-found']
    ])
    expect([done, orphan].map(existsSync)).toEqual([false, false])
    expect([dirty, review, alone, locked, outside].map(existsSync)).toEqual([true, true, true, true, true])
    // The task's folder went with its only worktree; the branch and its commit stay.
    expect(existsSync(path.dirname(done))).toBe(false)
    expect(git(app, 'log', '-1', '--format=%s', 'kando/d')).toBe('work')
    expect(released).toEqual([id('d')])
    expect(forgotten).toEqual([done])
    expect(changes()).toBe(1)
  })

  it('keeps a worktree whose task\'s agent is at work', async () => {
    const done = worktree('d')
    task('d', 'done', done)
    const refusing = new WorktreeService(root, { ...hooks, releaseAgent: async () => Promise.reject(new (await import('./rejection')).Rejection('worktree-in-use')) }, () => {})
    expect(await refusing.clean([done])).toEqual([{ path: done, removed: false, reason: 'worktree-in-use' }])
    expect(existsSync(done)).toBe(true)
  })
})
