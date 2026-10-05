import { describe, expect, it } from 'vitest'
import { Task, type ManagedWorktree } from '@kando/protocol'
import { formatBytes, groupWorktrees, worktreeRows, worktreeState, worktreeSummary } from './worktree-groups'

const worktree = (name: string, overrides: Partial<ManagedWorktree> = {}): ManagedWorktree => ({
  path: `/kando/worktrees/${name}/app`, repo: '/code/app', branch: `kando/${name}`, taskId: null, planning: false,
  changes: 0, unmerged: null, alone: false, inUse: false, locked: false, touchedAt: 0, size: null, ...overrides
})
const task = (id: string, status: Task['status']) =>
  Task.parse({ id, title: id, details: '', status, repos: [], dependsOn: [], agent: null, sessionId: null, createdAt: 0, updatedAt: 0 })

describe('worktree groups', () => {
  const tasks = { done: task('done', 'done'), gone: task('gone', 'abandoned'), review: task('review', 'review'), dirty: task('dirty', 'done') }
  const rows = worktreeRows([
    worktree('done', { taskId: 'done', touchedAt: 5, size: 2048 }),
    worktree('gone', { taskId: 'gone', touchedAt: 1, size: 1024 }),
    worktree('orphan'),
    worktree('review', { taskId: 'review' }),
    worktree('dirty', { taskId: 'dirty', changes: 2 }),
    worktree('open', { taskId: 'done', inUse: true, touchedAt: 9 })
  ], tasks)

  it('sorts worktrees by what can be done about them, the oldest first', () => {
    expect(groupWorktrees(rows).map((group) => [group.id, group.rows.map((row) => row.worktree.branch)])).toEqual([
      ['cleanable', ['kando/gone', 'kando/done']],
      ['orphaned', ['kando/orphan']],
      ['attention', ['kando/dirty', 'kando/open']],
      ['active', ['kando/review']]
    ])
  })

  it('sums what is known, counting a deleted task\'s clean worktree as one to clean', () => {
    expect(worktreeSummary(rows)).toEqual({ count: 6, bytes: 3072, counting: true, cleanable: 3 })
    expect([900, 5 * 1024 ** 2, 3.24 * 1024 ** 3].map(formatBytes)).toEqual(['1 KB', '5 MB', '3.2 GB'])
  })

  it('says why a worktree is kept, or how its commits stand', () => {
    expect(worktreeState({ worktree: worktree('x', { changes: 3 }) })).toEqual({ text: '3 个文件没提交', warn: true })
    expect(worktreeState({ worktree: worktree('x', { alone: true }) }).text).toBe('有只在这里的提交')
    expect(worktreeState({ worktree: worktree('x', { inUse: true }) })).toEqual({ text: 'Agent 还开着', warn: true })
    expect(worktreeState({ worktree: worktree('x', { changes: null, repo: null }) }).text).toBe('找不到它所属的仓库')
    expect(worktreeState({ worktree: worktree('x', { unmerged: { count: 2, into: 'origin/main' } }) })).toEqual({ text: '2 个提交还没合进 origin/main', warn: false })
    expect(worktreeState({ worktree: worktree('x', { unmerged: { count: 0, into: 'origin/main' } }) }).text).toBe('已合进 origin/main')
    expect(worktreeState({ worktree: worktree('x', { planning: true, branch: null }) }).text).toBe('规划用的只读副本')
  })

  it('keeps a conversation\'s worktree among the active ones while the conversation is there', () => {
    const held = worktreeRows([worktree('chat', { conversationId: 'c', changes: 2 })], {})
    expect(held[0]).toMatchObject({ task: null, conversation: null, blocker: 'conversation-open' })
    expect(groupWorktrees(held).map((group) => group.id)).toEqual(['active'])
    expect(worktreeSummary(held).cleanable).toBe(0)
  })
})
