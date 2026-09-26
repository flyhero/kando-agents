import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChangedFile, Commit, FileDiff } from '@kando/protocol'

const execFileAsync = promisify(execFile)

const MAX_COMMITS = 50
const MAX_DIFF_CHARS = 256 * 1024
// Large enough for a big diff to be cut on our terms rather than failing inside execFile.
const MAX_BUFFER = 16 * 1024 * 1024

// --no-optional-locks keeps every read off index.lock, which the agent's own git would trip on.
export async function git(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', dir, ...args], { maxBuffer: MAX_BUFFER })
  return stdout
}

export async function gitOrNull(dir: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await git(dir, args)).trim() || null
  } catch {
    return null
  }
}

function nameStatus(output: string): Array<Pick<ChangedFile, 'kind' | 'path' | 'oldPath'>> {
  const tokens = output.split('\0')
  const files: Array<Pick<ChangedFile, 'kind' | 'path' | 'oldPath'>> = []
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
function lineCounts(output: string): Map<string, Pick<ChangedFile, 'additions' | 'deletions'>> {
  const tokens = output.split('\0')
  const counts = new Map<string, Pick<ChangedFile, 'additions' | 'deletions'>>()
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

// Everything in the working tree that differs from `base`, committed or not, plus untracked files.
// With no base (a repo without commits yet) only the untracked files count.
export async function changedFiles(root: string, base: string | null): Promise<ChangedFile[]> {
  const [names, numstat, untracked] = await Promise.all([
    base ? git(root, ['diff', '--name-status', '-z', '-M', base]) : '',
    base ? git(root, ['diff', '--numstat', '-z', '-M', base]) : '',
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const counts = lineCounts(numstat)
  const tracked = nameStatus(names).map((file) => ({ ...file, ...(counts.get(file.path) ?? { additions: null, deletions: null }) }))
  const added = untracked.split('\0').filter(Boolean)
    .map((file) => ({ kind: 'untracked' as const, path: file, oldPath: null, additions: null, deletions: null }))
  return [...tracked, ...added].sort((a, b) => a.path.localeCompare(b.path))
}

export async function commitsSince(root: string, base: string): Promise<Commit[]> {
  const log = await git(root, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x00%s', `${base}..HEAD`])
  return log.split('\n').filter(Boolean).map((line) => {
    const [sha = '', subject = ''] = line.split('\0')
    return { sha, subject }
  })
}

// `file` must come from `changedFiles` for the same root and base, which keeps its path inside the tree.
export async function diffOf(root: string, base: string | null, file: ChangedFile): Promise<FileDiff> {
  let diff: string
  if (file.kind === 'untracked' || !base) {
    // --no-index exits 1 whenever the files differ, which for a new file is always.
    diff = await git(root, ['diff', '--no-index', '--', '/dev/null', file.path]).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return error.stdout
      throw error
    })
  } else {
    diff = await git(root, ['diff', '-M', base, '--', ...(file.oldPath ? [file.oldPath] : []), file.path])
  }
  return diff.length > MAX_DIFF_CHARS ? { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true } : { diff, truncated: false }
}
