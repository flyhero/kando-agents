import { describe, expect, it } from 'vitest'
import { commitRefs } from './git-refs'

describe('commit refs', () => {
  it('tells local branches, remote ones and tags apart, the checked-out branch first', () => {
    const refs = commitRefs(['origin/fix/edit-statistics-slow-sql', 'tag: v1.2', 'fix/edit-statistics-slow-sql', 'HEAD -> main'], ['origin', 'upstream'])
    expect(refs).toEqual([
      { name: 'main', kind: 'local', current: true },
      { name: 'fix/edit-statistics-slow-sql', kind: 'local', current: false },
      { name: 'origin/fix/edit-statistics-slow-sql', kind: 'remote', current: false },
      { name: 'v1.2', kind: 'tag', current: false }
    ])
  })

  it('keeps a local branch whose name starts like a remote that is not one, and a detached HEAD', () => {
    expect(commitRefs(['HEAD', 'originals/x', 'origin/x'], ['origin'])).toEqual([
      { name: 'HEAD', kind: 'head', current: true },
      { name: 'originals/x', kind: 'local', current: false },
      { name: 'origin/x', kind: 'remote', current: false }
    ])
  })
})
