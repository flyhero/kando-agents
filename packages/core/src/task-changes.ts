import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChangedFile, FileDiff, RepoChanges, TaskRepo } from '@kando/protocol'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

const MAX_COMMITS = 50
const MAX_DIFF_CHARS = 256 * 1024
// Large enough for a big diff to be cut on our terms rather than failing inside execFile.
const MAX_BUFFER = 16 * 1024 * 1024

// --no-optional-locks keeps every read off index.lock, which the agent's own git would trip on.
async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', dir, ...args], { maxBuffer: MAX_BUFFER })
  return stdout
}

async function gitOrNull(dir: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await git(dir, args)).trim() || null
  } catch {
    return null
  }
}

// Where the task's branch started: `worktree add -b` wrote that commit as the branch's first
// reflog entry, pulled back to an ancestor in case the branch was rebased since. Without one
// (expired, or the branch came from elsewhere) the fork point with the repo's own HEAD will do.
// Either way a branch stacked on a dependency's does not count that dependency's work as its own.
async function branchBase(repo: TaskRepo & { worktreePath: string }): Promise<string | null> {
  const reflog = repo.branch ? await gitOrNull(repo.worktreePath, ['reflog', 'show', '--format=%H', `refs/heads/${repo.branch}`]) : null
  const created = reflog?.split('\n').at(-1)
  const start = created ?? (await gitOrNull(repo.path, ['rev-parse', 'HEAD']))
  return start ? gitOrNull(repo.worktreePath, ['merge-base', start, 'HEAD']) : null
}

function nameStatus(output: string): Array<{ kind: ChangedFile['kind']; path: string; oldPath: string | null }> {
  const tokens = output.split('\0')
  const files: Array<{ kind: ChangedFile['kind']; path: string; oldPath: string | null }> = []
  for (let i = 0; i < tokens.length - 1; ) {
    const status = tokens[i] ?? ''
    if (status.startsWith('R')) {
      files.push({ kind: 'renamed', oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' })
      i += 3
    } else {
      const kind = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified'
      files.push({ kind, oldPath: null, path: tokens[i + 1] ?? '' })
      i += 2
    }
  }
  return files
}

// `--numstat -z` puts a rename's two paths in their own fields after an empty one; "-" marks binary.
function lineCounts(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = output.split('\0')
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (let i = 0; i < tokens.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? '')
    if (!match) continue
    let file = match[3] ?? ''
    if (file === '') {
      file = tokens[i + 2] ?? ''
      i += 2
    }
    const count = (value: string | undefined) => (value === undefined || value === '-' ? null : Number(value))
    counts.set(file, { additions: count(match[1]), deletions: count(match[2]) })
  }
  return counts
}

// The full base commit rides along so a diff never has to resolve the short one again.
async function inspect(repo: TaskRepo): Promise<{ changes: RepoChanges; base: string | null }> {
  const none = { changes: { path: repo.path, branch: repo.branch, base: null, commits: [], files: [] }, base: null }
  if (!repo.worktreePath) return none
  const worktree = { ...repo, worktreePath: repo.worktreePath }
  const base = await branchBase(worktree)
  if (!base) return none
  const [log, names, numstat, untracked] = await Promise.all([
    git(worktree.worktreePath, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x00%s', `${base}..HEAD`]),
    git(worktree.worktreePath, ['diff', '--name-status', '-z', '-M', base]),
    git(worktree.worktreePath, ['diff', '--numstat', '-z', '-M', base]),
    git(worktree.worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const counts = lineCounts(numstat)
  const tracked = nameStatus(names).map((file) => ({ ...file, ...(counts.get(file.path) ?? { additions: null, deletions: null }) }))
  const added = untracked.split('\0').filter(Boolean)
    .map((file) => ({ kind: 'untracked' as const, path: file, oldPath: null, additions: null, deletions: null }))
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha = '', subject = ''] = line.split('\0')
    return { sha, subject }
  })
  const files = [...tracked, ...added].sort((a, b) => a.path.localeCompare(b.path))
  return { changes: { path: repo.path, branch: repo.branch, base: base.slice(0, 7), commits, files }, base }
}

export async function repoChanges(repo: TaskRepo): Promise<RepoChanges> {
  return (await inspect(repo)).changes
}

// Only a file the change list names can be read, so the path cannot reach outside the worktree.
export async function fileDiff(repo: TaskRepo, file: string): Promise<FileDiff> {
  const { changes, base } = await inspect(repo)
  const changed = changes.files.find((each) => each.path === file)
  if (!repo.worktreePath || !base || !changed) throw new Rejection('file-not-changed', `${file} is not among the task's changes`)
  let diff: string
  if (changed.kind === 'untracked') {
    // --no-index exits 1 whenever the files differ, which for a new file is always.
    diff = await git(repo.worktreePath, ['diff', '--no-index', '--', '/dev/null', file]).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return error.stdout
      throw error
    })
  } else {
    diff = await git(repo.worktreePath, ['diff', '-M', base, '--', ...(changed.oldPath ? [changed.oldPath] : []), file])
  }
  return diff.length > MAX_DIFF_CHARS ? { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true } : { diff, truncated: false }
}
