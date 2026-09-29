import { execFile } from 'node:child_process'
import { mkdir, readdir, rmdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isFinished, shortTaskId, type RepoStartOptions, type Task, type TaskRepo, type TaskStart } from '@kando/protocol'
import { Rejection } from './rejection'
import { repoStartOptions, resolveStart } from './task-start'

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
  startRef: string | null
  start: TaskStart | null
}

export type Workspace = { cwd: string; extraDirs: string[]; multi: boolean; entries: WorkspaceEntry[]; repos: TaskRepo[] }

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
  return [...new Set(paths)].map((repoPath) => known.get(repoPath) ?? { path: repoPath, worktreePath: null, branch: null, startRef: null, start: null })
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

async function worktreeGit(dir: string, args: readonly string[]): Promise<void> {
  try {
    await execFileAsync('git', ['-C', dir, ...args])
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new Rejection('worktree-failed', stderr || `git ${args.join(' ')} failed`)
  }
}

// `args` add the worktree at `worktreePath`.
async function addWorktree(topLevel: string, worktreePath: string, args: readonly string[]): Promise<void> {
  await mkdir(path.dirname(worktreePath), { recursive: true })
  // A folder deleted by hand leaves git's record of it, which refuses the path. Only that record
  // goes, not every lost one as prune would, and without force, so a locked worktree stays.
  try {
    await execFileAsync('git', ['-C', topLevel, 'worktree', 'remove', worktreePath])
  } catch {
    // Never recorded, or locked: adding says why if it still cannot.
  }
  await worktreeGit(topLevel, ['worktree', 'add', ...args])
}

// Each git repo gets its own worktree on the task's branch, under one task directory.
// The agent works in the primary worktree and gets the others as additional directories.
// A plain folder runs in place, so it can only be a task's sole repo.
export async function prepareWorkspace(
  task: Pick<Task, 'id' | 'title' | 'repos' | 'source'>,
  dependencies: readonly Pick<Task, 'repos'>[],
  worktreesRoot: string,
  at = Date.now()
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
  // Reordering must not let a newly added repo claim a retained worktree's name.
  const taken = new Set(task.repos.flatMap((repo) => repo.worktreePath ? [path.basename(repo.worktreePath)] : []))
  const entries: WorkspaceEntry[] = []
  for (const { repo, topLevel } of resolved) {
    const name = repo.worktreePath ? path.basename(repo.worktreePath) : uniqueName(path.basename(topLevel ?? repo.path), taken)
    const { startRef } = repo
    if (repo.worktreePath && (await isDirectory(repo.worktreePath))) {
      entries.push({ name, source: repo.path, dir: repo.worktreePath, branch: repo.branch, base: null, startRef, start: repo.start })
    } else if (!topLevel) {
      entries.push({ name, source: repo.path, dir: repo.path, branch: null, base: null, startRef, start: null })
    } else {
      // A start the task picked wins over a dependency's branch.
      const base = startRef === null ? onlyBranch(stackable, topLevel) : null
      const worktreePath = repo.worktreePath ?? path.join(taskDir, name)
      const repoBranch = repo.branch ?? branch
      let start = repo.start
      // A leftover from a run that failed part-way is picked up as is, and a branch left by an
      // earlier, since-removed worktree is checked out again rather than recreated.
      if (!(await isDirectory(worktreePath))) {
        if (await branchExists(topLevel, repoBranch)) {
          await addWorktree(topLevel, worktreePath, [worktreePath, repoBranch])
        } else {
          const resolved = await resolveStart(topLevel, startRef, base, at)
          // --no-track: the branch is the task's own, not a copy of the one it started from.
          await addWorktree(topLevel, worktreePath, ['--no-track', '-b', repoBranch, worktreePath, resolved.commit])
          start = resolved.start
        }
      }
      entries.push({ name, source: repo.path, dir: worktreePath, branch: repoBranch, base, startRef, start })
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
    cwd: first.dir,
    extraDirs: entries.slice(1).map((entry) => entry.dir),
    multi,
    entries,
    repos: entries.map((entry) => ({
      path: entry.source,
      worktreePath: entry.dir === entry.source ? null : entry.dir,
      branch: entry.branch,
      startRef: entry.startRef,
      start: entry.start
    }))
  }
}

// Stack on a dependency's branch only when exactly one dependency left one in the repo; with
// several there is no single right base.
function onlyBranch(stackable: ReadonlyMap<string, string[]>, topLevel: string): string | null {
  const candidates = stackable.get(topLevel) ?? []
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

export async function startOptions(task: Pick<Task, 'repos'>, dependencies: readonly Pick<Task, 'repos'>[]): Promise<RepoStartOptions[]> {
  const stackable = await dependencyBranches(dependencies)
  return Promise.all(task.repos.map(async (repo) => {
    const topLevel = await gitTopLevel(repo.path)
    return repoStartOptions(repo.path, topLevel, topLevel ? onlyBranch(stackable, topLevel) : null)
  }))
}

export type RefineWorkspace = {
  cwd: string
  dirs: string[]
  // Dependency branches already contained in the code the agent reads.
  landed: ReadonlySet<string>
  // What each planning checkout holds, by its folder; a repo read where it is has none.
  starts: ReadonlyMap<string, TaskStart>
}

// Planning checkouts: the code a task's branch would start from, checked out with no branch, apart
// from the task's worktrees, which only execution lays out.
function planningRoot(worktreesRoot: string, taskId: string): string {
  return path.join(worktreesRoot, shortTaskId(taskId), '.planning')
}

async function isAncestor(dir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', dir, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'])
    return true
  } catch {
    return false
  }
}

// Planning only reads, and only tasks that never ran plan, so it makes no branch: each git repo is
// read at the commit the task's branch would start from, in a planning checkout, or where it is
// when that start is what the project has checked out. `refresh` moves an existing checkout to
// the start as it is now; a planning conversation picked up again keeps reading what it read.
export async function prepareRefineWorkspace(
  task: Pick<Task, 'id' | 'repos'>,
  dependencies: readonly Pick<Task, 'status' | 'repos'>[],
  worktreesRoot: string,
  { refresh = true, at = Date.now() }: { refresh?: boolean; at?: number } = {}
): Promise<RefineWorkspace> {
  const stackable = await dependencyBranches(dependencies)
  const root = planningRoot(worktreesRoot, task.id)
  const taken = new Set<string>()
  const dirs: string[] = []
  const starts = new Map<string, TaskStart>()
  for (const repo of task.repos) {
    if (!(await isDirectory(repo.path))) {
      throw new Rejection('repo-not-found', `repo path does not exist: ${repo.path}`)
    }
    const topLevel = await gitTopLevel(repo.path)
    if (!topLevel) {
      dirs.push(repo.path)
      continue
    }
    const checkout = path.join(root, uniqueName(path.basename(topLevel), taken))
    const exists = await isDirectory(checkout)
    if (exists && !refresh) {
      dirs.push(checkout)
      continue
    }
    const resolved = await resolveStart(topLevel, repo.startRef, repo.startRef === null ? onlyBranch(stackable, topLevel) : null, at)
    if (resolved.head) {
      dirs.push(repo.path)
      continue
    }
    if (exists) await worktreeGit(checkout, ['checkout', '--quiet', '--detach', resolved.commit])
    else await addWorktree(topLevel, checkout, ['--quiet', '--detach', checkout, resolved.commit])
    dirs.push(checkout)
    starts.set(checkout, resolved.start)
  }
  const first = dirs[0]
  if (!first) {
    throw new Rejection('missing-repo')
  }
  const landed = new Set<string>()
  const branches = dependencies
    .filter((dependency) => isFinished(dependency.status))
    .flatMap((dependency) => dependency.repos.flatMap((repo) => (repo.branch ? [repo.branch] : [])))
  for (const branch of new Set(branches)) {
    for (const dir of dirs) {
      if (await isAncestor(dir, branch)) {
        landed.add(branch)
        break
      }
    }
  }
  return { cwd: first, dirs, landed, starts }
}

// Once the task runs in its worktrees, its planning checkouts go. The agent only read there, but
// one holding changes after all stays (removing without force refuses it), as does one whose
// commit no ref contains, which only that checkout still holds.
export async function removePlanningCheckouts(taskId: string, worktreesRoot: string): Promise<void> {
  const root = planningRoot(worktreesRoot, taskId)
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const checkout = path.join(root, name)
    const kept = await execFileAsync('git', ['-C', checkout, 'for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)'])
      .then(({ stdout }) => stdout.trim() !== '', () => false)
    if (kept) await execFileAsync('git', ['-C', checkout, 'worktree', 'remove', checkout]).catch(() => {})
  }
  // Only empty folders go: a task directory keeps any worktree in it.
  for (const dir of [root, path.dirname(root)]) await rmdir(dir).catch(() => {})
}
