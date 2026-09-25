import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { branchKey, branchSlug, normalizeRepoPath, projectHead } from './workspace'

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
