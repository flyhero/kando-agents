import type { FileDiff, FolderChanges } from '@kando/protocol'
import { changedFiles, commitsSince, diffOf, gitOrNull } from './git-changes'
import { Rejection } from './rejection'

// Recorded when a conversation starts, so its later commits can be told apart from older ones.
export function folderHead(folder: string): Promise<string | null> {
  return gitOrNull(folder, ['rev-parse', 'HEAD'])
}

// A conversation works in the project folder itself, so what it changed is the repo's uncommitted
// work, which may include the user's own, plus the commits made since it started.
async function inspect(folder: string, start: string | null): Promise<{ changes: FolderChanges; root: string | null; head: string | null }> {
  const root = await gitOrNull(folder, ['rev-parse', '--show-toplevel'])
  if (!root) return { changes: { path: folder, branch: null, head: null, commits: null, files: [] }, root: null, head: null }
  const [head, branch] = await Promise.all([gitOrNull(root, ['rev-parse', 'HEAD']), gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])])
  const since = start && head ? await gitOrNull(root, ['merge-base', start, head]) : null
  const [commits, files] = await Promise.all([since ? commitsSince(root, since) : null, changedFiles(root, head)])
  return { changes: { path: folder, branch, head: head?.slice(0, 7) ?? null, commits, files }, root, head }
}

export async function folderChanges(folder: string, start: string | null): Promise<FolderChanges> {
  return (await inspect(folder, start)).changes
}

// Only a file the change list names can be read, so the path cannot reach outside the repo.
export async function folderDiff(folder: string, file: string): Promise<FileDiff> {
  const { changes, root, head } = await inspect(folder, null)
  const changed = changes.files.find((each) => each.path === file)
  if (!root || !changed) throw new Rejection('file-not-changed', `${file} has no uncommitted change`)
  return diffOf(root, head, changed)
}
