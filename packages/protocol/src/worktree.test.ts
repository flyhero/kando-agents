import { describe, expect, it } from 'vitest'
import { checkCleanWorktree } from './worktree'

describe('checkCleanWorktree', () => {
  const clean = { changes: 0, locked: false, alone: false, inUse: false }

  it('cleans a finished or deleted task\'s worktree that holds nothing uncommitted', () => {
    expect(checkCleanWorktree(clean, { status: 'done' })).toBeNull()
    expect(checkCleanWorktree(clean, { status: 'abandoned' })).toBeNull()
    expect(checkCleanWorktree(clean, null)).toBeNull()
  })

  it('keeps a task\'s own while it is under way, and anything that would lose work', () => {
    for (const status of ['pending', 'running', 'review'] as const) expect(checkCleanWorktree(clean, { status })).toBe('task-active')
    expect(checkCleanWorktree({ ...clean, inUse: true }, { status: 'done' })).toBe('worktree-in-use')
    expect(checkCleanWorktree({ ...clean, locked: true }, null)).toBe('worktree-locked')
    expect(checkCleanWorktree({ ...clean, changes: null }, null)).toBe('worktree-unreadable')
    expect(checkCleanWorktree({ ...clean, changes: 3 }, { status: 'done' })).toBe('worktree-dirty')
    expect(checkCleanWorktree({ ...clean, alone: true }, null)).toBe('worktree-alone')
  })
})
