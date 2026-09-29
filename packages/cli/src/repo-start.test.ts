import { describe, expect, it } from 'vitest'
import { repoStartText } from './repo-start'

describe('repoStartText', () => {
  it('says where a branch started, and why it was not the latest', () => {
    const start = { ref: 'origin/main', commit: 'bd03e52aa0', note: null, at: 0 }
    expect(repoStartText({ startRef: null, start })).toBe('从 origin/main bd03e52 拉出')
    expect(repoStartText({ startRef: null, start: { ...start, note: 'fetch-failed' } })).toBe('从 origin/main bd03e52 拉出（没能拉取最新的，用的是本地已有的）')
  })

  it('says what was picked before the branch is made, and nothing for the default', () => {
    expect(repoStartText({ startRef: 'refs/remotes/origin/release/2.4', start: null })).toBe('起点：origin/release/2.4')
    expect(repoStartText({ startRef: 'HEAD', start: null })).toBe('起点：项目当前的分支')
    expect(repoStartText({ startRef: null, start: null })).toBe('')
  })
})
