import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitCommit, ChangedFile, FileDiff } from '@kando/protocol'
import { git, gitOrNull } from './git-changes'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

export async function repositoryKey(dir: string): Promise<string | null> {
  const common = await gitOrNull(dir, ['rev-parse', '--git-common-dir'])
  return common ? realpath(path.resolve(dir, common)) : null
}

export async function writeGit(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
      timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' }
    })
    return stdout.trim()
  } catch (error) {
    const message = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error)
    throw new Rejection('git-operation-failed', message || 'Git 操作失败或超时，请刷新检查仓库状态。')
  }
}

export async function commitRef(dir: string, ref: string): Promise<string> {
  if (!(ref === 'HEAD' || /^refs\/(heads|remotes)\/[^\s]+$/.test(ref) || /^[0-9a-f]{40,64}$/.test(ref))) {
    throw new Rejection('branch-not-found', '无效的 Git 引用。')
  }
  const sha = await gitOrNull(dir, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!sha) throw new Rejection('branch-not-found', '引用已不存在，请刷新分支列表。')
  return sha
}

export async function gitOperation(dir: string): Promise<'merge' | 'other' | null> {
  for (const [name, kind] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'other'], ['rebase-apply', 'other'], ['CHERRY_PICK_HEAD', 'other'], ['REVERT_HEAD', 'other'], ['BISECT_LOG', 'other']] as const) {
    const file = await gitOrNull(dir, ['rev-parse', '--git-path', name])
    if (file && await access(path.resolve(dir, file)).then(() => true, () => false)) return kind
  }
  return null
}

export async function conflictFiles(dir: string): Promise<string[]> {
  const output = await git(dir, ['ls-files', '--unmerged', '-z'])
  return [...new Set(output.split('\0').filter(Boolean).map((entry) => entry.slice(entry.indexOf('\t') + 1)))]
}

export async function logCommits(dir: string, revisions: string[], offset = 0): Promise<GitCommit[]> {
  const args = ['log', '--topo-order', '--no-show-signature', '--no-color', '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%D%x00', `--skip=${offset}`, '--max-count=101']
  const output = await git(dir, [...args, ...revisions, '--'])
  return parseLog(output)
}

export function parseLog(output: string): GitCommit[] {
  const fields = output.split('\0')
  const commits: GitCommit[] = []
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const sha = fields[i]?.trim() ?? ''
    if (!sha) continue
    commits.push({ sha, parents: (fields[i + 1] ?? '').split(' ').filter(Boolean), subject: fields[i + 2] ?? '', author: fields[i + 3] ?? '', date: fields[i + 4] ?? '', refs: (fields[i + 5] ?? '').split(', ').filter(Boolean) })
  }
  return commits
}

export async function filesBetween(dir: string, base: string | null, sha: string): Promise<ChangedFile[]> {
  const args = base ? ['diff', base, sha] : ['diff-tree', '--root', '--no-commit-id', '-r', sha]
  const [names, stats] = await Promise.all([
    git(dir, [...args, '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', '--']),
    git(dir, [...args, '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', '--'])
  ])
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  const tokens = stats.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? '')
    if (!match) continue
    const file = match[3] || tokens[(i += 2)] || ''
    counts.set(file, { additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) })
  }
  const fields = names.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++] ?? ''
    const oldPath = status.startsWith('R') ? fields[i++] ?? null : null
    const file = fields[i++] ?? ''
    const kind = status.startsWith('R') ? 'renamed' : status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified'
    files.push({ path: file, oldPath, kind, ...counts.get(file) ?? { additions: null, deletions: null } })
  }
  return files
}

export async function committedDiff(dir: string, base: string | null, sha: string, file: string): Promise<FileDiff> {
  const entry = (await filesBetween(dir, base, sha)).find((entry) => entry.path === file)
  if (!entry) throw new Rejection('file-not-changed', '文件不在这次比较的改动中。')
  const args = base ? ['diff', base, sha] : ['diff-tree', '--root', '--no-commit-id', '-r', sha]
  const diff = await git(dir, [...args, '--no-ext-diff', '--no-textconv', '-M', '-p', '--', ...(entry.oldPath ? [entry.oldPath] : []), entry.path])
  return { diff: diff.slice(0, 256 * 1024), truncated: diff.length > 256 * 1024 }
}
