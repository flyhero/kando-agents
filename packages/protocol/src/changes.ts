import { z } from 'zod'

export const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed', 'untracked'] as const

// A file the task's agent changed, from where its branch started to the worktree as it is now.
export const ChangedFile = z.object({
  path: z.string(),
  // Where a renamed file came from.
  oldPath: z.string().nullable(),
  kind: z.enum(CHANGE_KINDS),
  // null for a binary file, or an untracked one git has not counted.
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable()
})
export type ChangedFile = z.infer<typeof ChangedFile>

export const Commit = z.object({ sha: z.string(), subject: z.string() })
export type Commit = z.infer<typeof Commit>

export const RepoChanges = z.object({
  // The repo as the user picked it; the changes themselves are in its worktree.
  path: z.string(),
  branch: z.string().nullable(),
  // Short id of the commit the branch started from; null without a worktree to compare.
  base: z.string().nullable(),
  commits: z.array(Commit),
  files: z.array(ChangedFile)
})
export type RepoChanges = z.infer<typeof RepoChanges>

// A conversation's project folder, which it shares with the user: no branch of its own to compare.
export const FolderChanges = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  // Short id of HEAD; null when the folder is not in a git repo, or the repo has no commit yet.
  head: z.string().nullable(),
  // Commits since the conversation started; null when it began before Kando recorded where.
  commits: z.array(Commit).nullable(),
  // Uncommitted against HEAD, untracked included; the user's own edits land here too.
  files: z.array(ChangedFile)
})
export type FolderChanges = z.infer<typeof FolderChanges>

export const FileDiff = z.object({ diff: z.string(), truncated: z.boolean() })
export type FileDiff = z.infer<typeof FileDiff>
