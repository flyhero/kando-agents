import { checkCleanWorktree, type ManagedWorktree, type Task, type WorktreeCleanBlocker } from '@kando/protocol'

export type WorktreeRow = { worktree: ManagedWorktree; task: Task | null; blocker: WorktreeCleanBlocker | null }

// Cleanable: a finished task's, safe to go. Orphaned: its task was deleted, the easiest to
// forget. Attention: holds something only the user can decide on. Active: its task is under way.
export type WorktreeGroupId = 'cleanable' | 'orphaned' | 'attention' | 'active'
export type WorktreeGroup = { id: WorktreeGroupId; rows: WorktreeRow[] }

export const GROUP_ORDER: readonly WorktreeGroupId[] = ['cleanable', 'orphaned', 'attention', 'active']

export function worktreeRows(worktrees: readonly ManagedWorktree[], tasks: Readonly<Record<string, Task>>): WorktreeRow[] {
  return worktrees.map((worktree) => {
    const task = worktree.taskId ? (tasks[worktree.taskId] ?? null) : null
    return { worktree, task, blocker: checkCleanWorktree(worktree, task) }
  })
}

function groupOf(row: WorktreeRow): WorktreeGroupId {
  if (!row.task) return 'orphaned'
  if (row.blocker === 'task-active') return 'active'
  return row.blocker ? 'attention' : 'cleanable'
}

// Oldest first within each: the longer one has lain untouched, the likelier it is forgotten.
export function groupWorktrees(rows: readonly WorktreeRow[]): WorktreeGroup[] {
  const sorted = [...rows].sort((a, b) => a.worktree.touchedAt - b.worktree.touchedAt)
  return GROUP_ORDER.map((id) => ({ id, rows: sorted.filter((row) => groupOf(row) === id) })).filter((group) => group.rows.length > 0)
}

export type WorktreeSummary = { count: number; bytes: number; counting: boolean; cleanable: number }

export function worktreeSummary(rows: readonly WorktreeRow[]): WorktreeSummary {
  return {
    count: rows.length,
    bytes: rows.reduce((sum, row) => sum + (row.worktree.size ?? 0), 0),
    counting: rows.some((row) => row.worktree.size === null),
    cleanable: rows.filter((row) => row.blocker === null).length
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// What stands out about a worktree, in a few words: why it is kept, or how its commits stand.
export function worktreeState({ worktree }: Pick<WorktreeRow, 'worktree'>): { text: string; warn: boolean } {
  if (worktree.changes === null) return { text: worktree.repo === null ? '找不到它所属的仓库' : '读不了它的 git 状态', warn: true }
  if (worktree.inUse) return { text: 'agent 还开着', warn: true }
  if (worktree.changes > 0) return { text: `${worktree.changes} 个文件没提交`, warn: true }
  if (worktree.alone) return { text: '有只在这里的提交', warn: true }
  if (worktree.locked) return { text: '已用 git worktree lock 锁定', warn: true }
  if (worktree.planning) return { text: '规划用的只读副本', warn: false }
  if (!worktree.unmerged) return { text: '没有未提交的改动', warn: false }
  const { count, into } = worktree.unmerged
  return { text: count > 0 ? `${count} 个提交还没合进 ${into}` : `已合进 ${into}`, warn: false }
}
