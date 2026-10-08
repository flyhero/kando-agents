import type { FileDiff, RepoChanges, TaskRepo } from '@kando/protocol'
import { changedFileAt, changedFiles, commitsSince, diffOf, gitOrNull } from './git-changes'
import { Rejection } from './rejection'

// Where the task's branch started: the commit Kando recorded when it made the branch, or for a
// branch made before that was recorded, the first entry of its reflog. Pulled back to an ancestor
// in case the branch was rebased since. Without either (the reflog expired, or the branch came
// from elsewhere) the fork point with the repo's own HEAD will do. Either way a branch stacked on
// a dependency's does not count that dependency's work as its own.
async function branchBase(repo: TaskRepo & { worktreePath: string }): Promise<string | null> {
  const reflog = !repo.start && repo.branch ? await gitOrNull(repo.worktreePath, ['reflog', 'show', '--format=%H', `refs/heads/${repo.branch}`]) : null
  const created = repo.start?.commit ?? reflog?.split('\n').at(-1)
  const start = created ?? (await gitOrNull(repo.path, ['rev-parse', 'HEAD']))
  return start ? gitOrNull(repo.worktreePath, ['merge-base', start, 'HEAD']) : null
}

// The full base commit rides along so a diff never has to resolve the short one again.
async function inspect(repo: TaskRepo): Promise<{ changes: RepoChanges; base: string | null }> {
  const none = { changes: { path: repo.path, branch: repo.branch, base: null, commits: [], files: [] }, base: null }
  if (!repo.worktreePath) return none
  const base = await branchBase({ ...repo, worktreePath: repo.worktreePath })
  if (!base) return none
  const [commits, files] = await Promise.all([commitsSince(repo.worktreePath, base), changedFiles(repo.worktreePath, base)])
  return { changes: { path: repo.path, branch: repo.branch, base: base.slice(0, 7), commits, files }, base }
}

export async function repoChanges(repo: TaskRepo): Promise<RepoChanges> {
  return (await inspect(repo)).changes
}

// Only a file the change list names can be read, so the path cannot reach outside the worktree.
export async function fileDiff(repo: TaskRepo, file: string): Promise<FileDiff> {
  const { changes, base } = await inspect(repo)
  const changed = repo.worktreePath ? await changedFileAt(repo.worktreePath, changes.files, file) : undefined
  if (!repo.worktreePath || !base || !changed) throw new Rejection('file-not-changed', `${file} is not among the task's changes`)
  return diffOf(repo.worktreePath, base, changed)
}
