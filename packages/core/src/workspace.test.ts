import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { branchKey, branchSlug, normalizeRepoPath, prepareWorkspace, projectHead } from './workspace'

describe('branchKey', () => {
  it('keeps an issue key as it is, and strips what a branch name should not carry', () => {
    expect(branchKey('PROJ-7')).toBe('PROJ-7')
    expect(branchKey('bug.12..lock')).toBe('bug-12-lock')
    expect(branchKey('-x-')).toBe('x')
  })
})

describe('branchSlug', () => {
  it('keeps ascii words and drops everything else', () => {
    expect(branchSlug('Fix: login (OAuth)!')).toBe('fix-login-oauth')
    expect(branchSlug('重构登录')).toBe('')
  })
})

describe('normalizeRepoPath', () => {
  it('expands ~ and rejects relative paths', () => {
    expect(normalizeRepoPath('~/code/app')).toBe(path.join(os.homedir(), 'code/app'))
    expect(() => normalizeRepoPath('code/app')).toThrow(/absolute/)
  })
})

describe('projectHead', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kando-head-'))
    dirs.push(dir)
    return dir
  }
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

  it('reads the branch, even before the first commit, and a detached commit', async () => {
    const dir = tempDir()
    git(dir, 'init', '-q', '-b', 'main')
    expect(await projectHead(dir)).toMatchObject({ branch: 'main', detached: false, upstream: null, changes: 0 })
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(dir, 'checkout', '-q', '-b', 'feature/login')
    expect(await projectHead(dir)).toMatchObject({ branch: 'feature/login', detached: false })
    git(dir, 'checkout', '-q', '--detach')
    expect(await projectHead(dir)).toMatchObject({ branch: git(dir, 'rev-parse', 'HEAD').slice(0, 7), detached: true })
  })

  it('counts uncommitted changes, untracked files included, and commits against the upstream', async () => {
    const remote = tempDir()
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    const dir = tempDir()
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'a.txt'), 'a')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'a')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'local')
    writeFileSync(path.join(dir, 'a.txt'), 'changed')
    writeFileSync(path.join(dir, 'new.txt'), 'new')
    expect(await projectHead(dir)).toEqual({ branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 0, changes: 2 })
  })

  it('has no branch outside a git repo', async () => {
    expect(await projectHead(tempDir())).toMatchObject({ branch: null, detached: false })
  })
})

describe('prepareWorkspace', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kando-workspace-'))
    dirs.push(dir)
    return dir
  }
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const repo = () => {
    const dir = tempDir()
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    return dir
  }
  const task = (repoPath: string) => ({ id: '76b8c0de-0000-4000-8000-000000000000', title: 'Fix login', repos: [{ path: repoPath, worktreePath: null, branch: null }], source: null })
  const registered = (dir: string) => git(dir, 'worktree', 'list', '--porcelain')

  it('lays out again, on its branch, a worktree whose folder was deleted by hand', async () => {
    const source = repo()
    const root = tempDir()
    const first = await prepareWorkspace(task(source), [], root)
    git(first.cwd, 'commit', '-q', '--allow-empty', '-m', 'work')
    const work = git(first.cwd, 'rev-parse', 'HEAD')
    // Another worktree git has lost track of is the user's, and stays recorded.
    const elsewhere = path.join(tempDir(), 'elsewhere')
    git(source, 'worktree', 'add', '-q', '-b', 'mine', elsewhere)
    rmSync(elsewhere, { recursive: true, force: true })
    rmSync(first.cwd, { recursive: true, force: true })

    const again = await prepareWorkspace({ ...task(source), repos: first.repos }, [], root)
    expect(again.cwd).toBe(first.cwd)
    expect(git(again.cwd, 'rev-parse', 'HEAD')).toBe(work)
    expect(git(again.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(first.repos[0]?.branch)
    expect(registered(source)).toMatch(/^worktree .*elsewhere$/m)
  })

  it('leaves a worktree the user locked as it is', async () => {
    const source = repo()
    const root = tempDir()
    const first = await prepareWorkspace(task(source), [], root)
    git(source, 'worktree', 'lock', first.cwd)
    rmSync(first.cwd, { recursive: true, force: true })

    await expect(prepareWorkspace({ ...task(source), repos: first.repos }, [], root)).rejects.toMatchObject({ reason: 'worktree-failed' })
    expect(registered(source)).toMatch(/^locked$/m)
  })
})
