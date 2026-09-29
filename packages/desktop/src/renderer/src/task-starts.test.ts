import { describe, expect, it } from 'vitest'
import type { RepoStartOptions } from '@kando/protocol'
import { fallbackText, pickedText, shortRef } from './task-starts'

const option = (overrides: Partial<RepoStartOptions> = {}): RepoStartOptions => ({
  path: '/code/app',
  git: true,
  current: 'feature/login',
  fallback: 'refs/remotes/origin/main',
  stacked: false,
  refs: [],
  ...overrides
})
const nobody = () => undefined

describe('task starts in words', () => {
  it('names branches as git does on the command line', () => {
    expect(shortRef('refs/heads/release/2.4')).toBe('release/2.4')
    expect(shortRef('refs/remotes/origin/main')).toBe('origin/main')
    expect(shortRef('HEAD')).toBe('HEAD')
  })

  it('says what starts the branch when nothing is picked', () => {
    expect(fallbackText(option(), nobody)).toEqual({ ref: 'origin/main', says: 'origin 的默认分支，开始前先拉取' })
    expect(fallbackText(option({ fallback: 'refs/heads/kando/5e1a-api', stacked: true }), (branch) => (branch === 'kando/5e1a-api' ? '登录接口' : undefined)))
      .toEqual({ ref: 'kando/5e1a-api', says: '依赖任务「登录接口」的分支' })
    expect(fallbackText(option({ fallback: null }), nobody)).toEqual({ ref: 'feature/login', says: '没有 origin 的默认分支，用项目当前的分支' })
  })

  it('shows what was picked, and that a remote branch is fetched first', () => {
    expect(pickedText({ startRef: null }, option(), nobody)).toEqual({ ref: 'origin/main', says: '默认' })
    expect(pickedText({ startRef: 'HEAD' }, option(), nobody)).toEqual({ ref: 'feature/login', says: '项目当前的分支' })
    expect(pickedText({ startRef: 'refs/heads/release/2.4' }, option(), nobody)).toEqual({ ref: 'release/2.4', says: null })
    expect(pickedText({ startRef: 'refs/remotes/origin/hotfix' }, option(), nobody)).toEqual({ ref: 'origin/hotfix', says: '开始前先拉取' })
  })
})
