import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { shortTaskId, type Task, type TaskRepo } from '@kando/protocol'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

export type WorkspaceEntry = {
  // Folder name under the task directory; unique within the task.
  name: string
  source: string
  // Where the agent works on this repo: its worktree, or the folder itself.
  dir: string
  branch: string | null
  // The dependency branch a new worktree was started from, if any.
  base: string | null
}

export type Workspace = { cwd: string; multi: boolean; entries: WorkspaceEntry[]; repos: TaskRepo[] }

export function normalizeRepoPath(input: string): string {
  const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input
  if (!path.isAbsolute(expanded)) {
    throw new Rejection('repo-path-not-absolute', `repo path must be absolute: ${input}`)
  }
  return path.normalize(expanded)
}

// Keeps what earlier runs recorded for repos that stay on the list.
export function withKnownWorktrees(current: readonly TaskRepo[], paths: readonly string[]): TaskRepo[] {
  const known = new Map(current.map((repo) => [repo.path, repo]))
  return [...new Set(paths)].map((repoPath) => known.get(repoPath) ?? { path: repoPath, worktreePath: null, branch: null })
}

// Keys are checked on import, but a branch name gets only what git and every shell take plainly.
export function branchKey(key: string): string {
  return key
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function gitTopLevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
    return path.normalize(stdout.trim())
  } catch {
    return null
  }
}

export type ProjectStatus = {
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  changes: number
}

const NOT_A_REPO: ProjectStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, changes: 0 }

// One status call gives the branch, its upstream and the uncommitted count. --no-optional-locks
// keeps it off index.lock, which the agent's own git commands in the same folder would trip on.
export async function projectHead(dir: string): Promise<ProjectStatus> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v2', '--branch']))
  } catch {
    return NOT_A_REPO
  }
  const lines = stdout.split('\n').filter(Boolean)
  const header = (key: string) => lines.find((line) => line.startsWith(`# branch.${key} `))?.slice(`# branch.${key} `.length) ?? null
  const head = header('head')
  const detached = head === '(detached)'
  const counts = header('ab')?.match(/^\+(\d+) -(\d+)$/)
  return {
    branch: detached ? header('oid')?.slice(0, 7) ?? null : head,
    detached,
    upstream: header('upstream'),
    ahead: Number(counts?.[1] ?? 0),
    behind: Number(counts?.[2] ?? 0),
    changes: lines.filter((line) => !line.startsWith('#')).length
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let n = 2; taken.has(name); n++) {
    name = `${base}-${n}`
  }
  taken.add(name)
  return name
}

// Branches that dependencies left in each repo, keyed by the repo's top level.
async function dependencyBranches(dependencies: readonly Pick<Task, 'repos'>[]): Promise<Map<string, string[]>> {
  const branches = new Map<string, string[]>()
  for (const repo of dependencies.flatMap((dependency) => dependency.repos)) {
    const topLevel = repo.branch ? await gitTopLevel(repo.path) : null
    if (topLevel && repo.branch && (await branchExists(topLevel, repo.branch))) {
      branches.set(topLevel, [...new Set([...(branches.get(topLevel) ?? []), repo.branch])])
    }
  }
  return branches
}

async function addWorktree(topLevel: string, worktreePath: string, branch: string, base: string): Promise<void> {
  await mkdir(path.dirname(worktreePath), { recursive: true })
  // A branch left by an earlier, since-removed worktree is checked out again rather than recreated.
  const args = (await branchExists(topLevel, branch))
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, base]
  try {
    await execFileAsync('git', ['-C', topLevel, ...args])
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new Rejection('worktree-failed', stderr || 'git worktree add failed')
  }
}

// Each git repo gets its own worktree on the task's branch, under one task directory.
// One repo: the agent works inside that worktree. Several: it works in the task
// directory, one subfolder per repo. A plain folder runs in place, so it can only
// be a task's sole repo.
export async function prepareWorkspace(
  task: Pick<Task, 'id' | 'title' | 'repos' | 'source'>,
  dependencies: readonly Pick<Task, 'repos'>[],
  worktreesRoot: string
): Promise<Workspace> {
  const shortId = shortTaskId(task.id)
  // An issue key in the branch name is how Jira links the branch to the issue.
  const slug = branchSlug(task.title)
  const key = task.source ? branchKey(task.source.key) : ''
  const branch = `kando/${key ? `${key}-` : ''}${shortId}${slug ? `-${slug}` : ''}`
  const taskDir = path.join(worktreesRoot, shortId)
  const multi = task.repos.length > 1

  const resolved: { repo: TaskRepo; topLevel: string | null }[] = []
  for (const repo of task.repos) {
    if (!(await isDirectory(repo.path))) {
      throw new Rejection('repo-not-found', `repo path does not exist: ${repo.path}`)
    }
    const topLevel = await gitTopLevel(repo.path)
    if (multi && !topLevel) {
      throw new Rejection('repo-not-git', `every repo of a multi-repo task must be a git repo: ${repo.path}`)
    }
    resolved.push({ repo, topLevel })
  }
  const topLevels = resolved.flatMap(({ topLevel }) => (topLevel ? [topLevel] : []))
  if (new Set(topLevels).size !== topLevels.length) {
    throw new Rejection('repo-duplicate', 'two entries point into the same git repo')
  }

  const stackable = await dependencyBranches(dependencies)
  const taken = new Set<string>()
  const entries: WorkspaceEntry[] = []
  for (const { repo, topLevel } of resolved) {
    const name = uniqueName(path.basename(topLevel ?? repo.path), taken)
    if (repo.worktreePath && (await isDirectory(repo.worktreePath))) {
      entries.push({ name, source: repo.path, dir: repo.worktreePath, branch: repo.branch, base: null })
    } else if (!topLevel) {
      entries.push({ name, source: repo.path, dir: repo.path, branch: null, base: null })
    } else {
      // Stack on a dependency's branch only when exactly one dependency left one here;
      // with several there is no single right base, so start from HEAD.
      const candidates = stackable.get(topLevel) ?? []
      const base = candidates.length === 1 ? (candidates[0] ?? null) : null
      const worktreePath = path.join(taskDir, name)
      // A leftover from a run that failed part-way is picked up as is.
      if (!(await isDirectory(worktreePath))) {
        await addWorktree(topLevel, worktreePath, branch, base ?? 'HEAD')
      }
      entries.push({ name, source: repo.path, dir: worktreePath, branch, base })
    }
  }

  if (multi) {
    await mkdir(taskDir, { recursive: true })
  }
  const first = entries[0]
  if (!first) {
    throw new Rejection('missing-repo')
  }
  return {
    cwd: multi ? taskDir : first.dir,
    multi,
    entries,
    repos: entries.map((entry) => ({
      path: entry.source,
      worktreePath: entry.dir === entry.source ? null : entry.dir,
      branch: entry.branch
    }))
  }
}

export type RefineWorkspace = {
  cwd: string
  dirs: string[]
  // Dependency branches already contained in the code the agent reads.
  landed: ReadonlySet<string>
}

async function isAncestor(dir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', dir, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'])
    return true
  } catch {
    return false
  }
}

// Refining only reads, and only tasks that never ran are refined, so it works in the
// repos themselves and creates no worktree or branch: talking leaves nothing behind.
export async function prepareRefineWorkspace(
  task: Pick<Task, 'repos'>,
  dependencies: readonly Pick<Task, 'status' | 'repos'>[]
): Promise<RefineWorkspace> {
  const dirs: string[] = []
  for (const repo of task.repos) {
    if (!(await isDirectory(repo.path))) {
      throw new Rejection('repo-not-found', `repo path does not exist: ${repo.path}`)
    }
    dirs.push(repo.path)
  }
  const first = dirs[0]
  if (!first) {
    throw new Rejection('missing-repo')
  }
  const landed = new Set<string>()
  const branches = dependencies
    .filter((dependency) => dependency.status === 'done')
    .flatMap((dependency) => dependency.repos.flatMap((repo) => (repo.branch ? [repo.branch] : [])))
  for (const branch of new Set(branches)) {
    for (const dir of dirs) {
      if (await isAncestor(dir, branch)) {
        landed.add(branch)
        break
      }
    }
  }
  return { cwd: first, dirs, landed }
}
