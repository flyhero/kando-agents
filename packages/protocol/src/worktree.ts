import { z } from 'zod'
import type { Task } from './task'

// A git worktree Kando laid out under its worktrees folder: a task's, a planning checkout, or one
// whose task was deleted. Kando never removes one of its own accord; the user cleans them up.
export const ManagedWorktree = z.object({
  path: z.string(),
  // The project it belongs to: the repo's main working tree; null when git cannot say.
  repo: z.string().nullable(),
  // Null when it has no branch checked out, as a planning checkout has not.
  branch: z.string().nullable(),
  // The task it was laid out for, while that task is still there.
  taskId: z.string().nullable(),
  planning: z.boolean(),
  // Uncommitted files, untracked ones included; null when git could not read it.
  changes: z.number().int().nullable(),
  // Commits on it that origin's default branch lacks; null when the repo has no such branch.
  unmerged: z.object({ count: z.number().int(), into: z.string() }).nullable(),
  // Checked out at a commit no branch or other ref has, which only this worktree still holds.
  alone: z.boolean(),
  // Its task's agent is open in it: a terminal still running, or a chat mid-turn.
  inUse: z.boolean().default(false),
  locked: z.boolean(),
  // When git last touched it (its index), else when its folder changed.
  touchedAt: z.number(),
  // Bytes on disk; null until counted, which happens in the background.
  size: z.number().nullable()
})
export type ManagedWorktree = z.infer<typeof ManagedWorktree>

export const WorktreeCleanResult = z.object({ path: z.string(), removed: z.boolean(), reason: z.string().nullable() })
export type WorktreeCleanResult = z.infer<typeof WorktreeCleanResult>

export type WorktreeCleanBlocker = 'task-active' | 'worktree-in-use' | 'worktree-locked' | 'worktree-unreadable' | 'worktree-dirty' | 'worktree-alone'

// Cleaning a worktree loses nothing when it holds nothing uncommitted: its commits stay on its
// branch, from which continuing the task lays it out again. A task still under way keeps its own.
export function checkCleanWorktree(
  worktree: Pick<ManagedWorktree, 'changes' | 'locked' | 'alone' | 'inUse'>,
  task: Pick<Task, 'status'> | null
): WorktreeCleanBlocker | null {
  if (task && task.status !== 'done' && task.status !== 'abandoned') return 'task-active'
  if (worktree.inUse) return 'worktree-in-use'
  if (worktree.locked) return 'worktree-locked'
  if (worktree.changes === null) return 'worktree-unreadable'
  if (worktree.changes > 0) return 'worktree-dirty'
  return worktree.alone ? 'worktree-alone' : null
}
