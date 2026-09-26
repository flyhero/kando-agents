import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileDiff, repoChanges } from './task-changes'

describe('task changes', () => {
  let root: string
  let repo: string
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const worktree = (branch: string, from: string) => {
    const dir = path.join(root, branch.replaceAll('/', '-'))
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir, from)
    return dir
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-changes-'))
    repo = path.join(root, 'app')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(path.join(repo, 'b.txt'), 'bee\n')
    writeFileSync(path.join(repo, 'old.txt'), 'moved\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists committed and uncommitted work since the branch started, and nothing main did after', async () => {
    const dir = worktree('kando/x', 'HEAD')
    writeFileSync(path.join(repo, 'main.txt'), 'later on main\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'main moved on')

    writeFileSync(path.join(dir, 'a.txt'), 'one\n2\nthree\n')
    git(dir, 'mv', 'old.txt', 'new.txt')
    git(dir, 'commit', '-q', '-am', 'edit a, rename old')
    unlinkSync(path.join(dir, 'b.txt'))
    writeFileSync(path.join(dir, 'c.txt'), 'new file\n')
    writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 0]))
    git(dir, 'add', 'logo.bin')

    const changes = await repoChanges({ path: repo, worktreePath: dir, branch: 'kando/x' })
    expect(changes.commits.map((commit) => commit.subject)).toEqual(['edit a, rename old'])
    expect(changes.files).toEqual([
      { path: 'a.txt', oldPath: null, kind: 'modified', additions: 2, deletions: 1 },
      { path: 'b.txt', oldPath: null, kind: 'deleted', additions: 0, deletions: 1 },
      { path: 'c.txt', oldPath: null, kind: 'untracked', additions: null, deletions: null },
      { path: 'logo.bin', oldPath: null, kind: 'added', additions: null, deletions: null },
      { path: 'new.txt', oldPath: 'old.txt', kind: 'renamed', additions: 0, deletions: 0 }
    ])
  })

  it('leaves a dependency\'s work out when the branch was stacked on it', async () => {
    const dep = worktree('kando/dep', 'HEAD')
    writeFileSync(path.join(dep, 'dep.txt'), 'dependency\n')
    git(dep, 'add', '.')
    git(dep, 'commit', '-q', '-m', 'dep work')
    const dir = worktree('kando/task', 'kando/dep')
    writeFileSync(path.join(dir, 'task.txt'), 'task\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'task work')

    const changes = await repoChanges({ path: repo, worktreePath: dir, branch: 'kando/task' })
    expect(changes.commits.map((commit) => commit.subject)).toEqual(['task work'])
    expect(changes.files.map((file) => file.path)).toEqual(['task.txt'])
  })

  it('falls back to the fork point with the repo\'s HEAD once the reflog is gone', async () => {
    const dir = worktree('kando/x', 'HEAD')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'task')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moved on')
    git(repo, 'reflog', 'expire', '--expire=now', '--all')

    const changes = await repoChanges({ path: repo, worktreePath: dir, branch: 'kando/x' })
    expect(changes.commits.map((commit) => commit.subject)).toEqual(['task'])
  })

  it('has nothing to compare before the task has a worktree', async () => {
    expect(await repoChanges({ path: repo, worktreePath: null, branch: null })).toMatchObject({ base: null, files: [] })
  })

  it('diffs one changed file, new ones included, and refuses any path outside the change list', async () => {
    const dir = worktree('kando/x', 'HEAD')
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(path.join(dir, 'c.txt'), 'new file\n')
    const task = { path: repo, worktreePath: dir, branch: 'kando/x' }

    expect((await fileDiff(task, 'a.txt')).diff).toContain('+three')
    expect(await fileDiff(task, 'c.txt')).toMatchObject({ diff: expect.stringContaining('+new file'), truncated: false })
    await expect(fileDiff(task, 'b.txt')).rejects.toMatchObject({ reason: 'file-not-changed' })
    await expect(fileDiff(task, '../app/a.txt')).rejects.toMatchObject({ reason: 'file-not-changed' })
  })
})
