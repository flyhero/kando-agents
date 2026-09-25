import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { branchKey, branchSlug, normalizeRepoPath } from './workspace'

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
