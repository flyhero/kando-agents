import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

  it('reads the branch, even before the first commit, and a detached commit', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-head-'))
    git('init', '-q', '-b', 'main')
    expect(await projectHead(dir)).toEqual({ branch: 'main', detached: false })
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('checkout', '-q', '-b', 'feature/login')
    expect(await projectHead(dir)).toEqual({ branch: 'feature/login', detached: false })
    git('checkout', '-q', '--detach')
    expect(await projectHead(dir)).toEqual({ branch: git('rev-parse', '--short', 'HEAD'), detached: true })
  })

  it('has no branch outside a git repo', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-head-'))
    expect(await projectHead(dir)).toEqual({ branch: null, detached: false })
  })
})
