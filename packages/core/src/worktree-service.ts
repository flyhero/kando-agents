import { execFile } from 'node:child_process'
import { readdir, realpath, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { checkCleanWorktree, shortTaskId, type Conversation, type ManagedWorktree, type Task, type WorktreeCleanResult } from '@kando/protocol'
import { gitOrNull } from './git-changes'
import { Rejection } from './rejection'
import { originDefault } from './task-start'

const execFileAsync = promisify(execFile)

// Sizes are counted again once this old: a worktree grows as its task builds and installs.
const SIZE_TTL_MS = 10 * 60 * 1000
const PLANNING = '.planning'

// What cleaning needs of the tasks: who owns a worktree, and letting go of it.
export type WorktreeTasks = {
  list(): Task[]
  // Tasks whose agent is open in their worktrees: a terminal still running, or a chat mid-turn.
  inUse(): Promise<ReadonlySet<string>>
  // Stops the task's idle chat agent, whose folder is about to go; refuses one at work.
  releaseAgent(taskId: string): Promise<void>
  // The task no longer has the worktree; running it again lays it out anew from its branch.
  forgetWorktree(taskId: string, worktreePath: string): void
}

// The conversations outside any task, whose projects may be worktrees Kando laid out for them.
export type WorktreeConversations = { list(): Pick<Conversation, 'id' | 'projectPaths' | 'chat'>[] }

type Folder = { dir: string; shortId: string; planning: boolean }

// A linked worktree has a .git file pointing into its repo, where a repo has a .git folder.
async function isWorktree(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, '.git'))).isFile()
  } catch {
    return false
  }
}

async function entries(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [])
}

// Kando lays worktrees out as <root>/<task>/<project>, planning checkouts as
// <root>/<task>/.planning/<project>; a task folder that is itself a worktree is the older layout.
async function folders(root: string): Promise<Folder[]> {
  const found: Folder[] = []
  for (const shortId of await entries(root)) {
    const taskDir = path.join(root, shortId)
    if (await isWorktree(taskDir)) {
      found.push({ dir: taskDir, shortId, planning: false })
      continue
    }
    for (const name of await entries(taskDir)) {
      const dir = path.join(taskDir, name)
      if (name !== PLANNING) {
        if (await isWorktree(dir)) found.push({ dir, shortId, planning: false })
        continue
      }
      for (const project of await entries(dir)) {
        if (await isWorktree(path.join(dir, project))) found.push({ dir: path.join(dir, project), shortId, planning: true })
      }
    }
  }
  return found
}

async function mtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

// du is far quicker than walking a tree of node_modules here, where there is one. It exits
// non-zero over a file it cannot read, still printing the total.
async function diskUsage(dir: string): Promise<number | null> {
  if (process.platform !== 'win32') {
    const stdout = await execFileAsync('du', ['-sk', dir]).then(
      (result) => result.stdout,
      (error: unknown) => (error instanceof Error && 'stdout' in error ? String(error.stdout) : '')
    )
    const kilobytes = Number(stdout.split('\t')[0])
    if (Number.isFinite(kilobytes) && stdout.trim()) return kilobytes * 1024
  }
  return walkedSize(dir)
}

async function walkedSize(root: string): Promise<number | null> {
  let total = 0
  const pending = [root]
  try {
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) pending.push(full)
        else total += (await stat(full).catch(() => null))?.size ?? 0
      }
    }
  } catch {
    return null
  }
  return total
}

export class WorktreeService {
  private readonly sizes = new Map<string, { bytes: number; at: number }>()
  private counting = false

  constructor(
    private readonly root: string,
    private readonly tasks: WorktreeTasks,
    private readonly changed: () => void,
    private readonly conversations: WorktreeConversations = { list: () => [] },
    private readonly now: () => number = Date.now
  ) {}

  // What git says of each worktree now; sizes are the last counted, and any missing or stale are
  // counted in the background, which says when it is done.
  async list(): Promise<ManagedWorktree[]> {
    const worktrees = await this.inspectAll()
    this.countSizes(worktrees.map((worktree) => worktree.path))
    return worktrees
  }

  // Each is looked at again as it stands, so nothing that changed since the list was read goes.
  async clean(paths: readonly string[]): Promise<WorktreeCleanResult[]> {
    const current = new Map((await this.inspectAll()).map((worktree) => [worktree.path, worktree]))
    const tasks = new Map(this.tasks.list().map((task) => [task.id, task]))
    const results: WorktreeCleanResult[] = []
    for (const requested of paths) {
      // Only a worktree Kando laid out, as the list found it, is ever removed.
      const worktree = current.get(path.normalize(requested))
      if (!worktree) {
        results.push({ path: requested, removed: false, reason: 'worktree-not-found' })
        continue
      }
      const task = worktree.taskId ? (tasks.get(worktree.taskId) ?? null) : null
      const blocker = checkCleanWorktree(worktree, task)
      if (blocker) {
        results.push({ path: worktree.path, removed: false, reason: blocker })
        continue
      }
      results.push(await this.remove(worktree, task))
    }
    this.changed()
    return results
  }

  private async remove(worktree: ManagedWorktree, task: Task | null): Promise<WorktreeCleanResult> {
    try {
      if (task) await this.tasks.releaseAgent(task.id)
      // Without force: git refuses, again, a worktree that holds changes after all.
      await execFileAsync('git', ['-C', worktree.path, 'worktree', 'remove', worktree.path])
    } catch (error) {
      const reason = error instanceof Rejection ? error.reason : 'worktree-failed'
      return { path: worktree.path, removed: false, reason }
    }
    if (task) this.tasks.forgetWorktree(task.id, worktree.path)
    this.sizes.delete(worktree.path)
    // Folders Kando made for it go when nothing else is left in them.
    for (let dir = path.dirname(worktree.path); dir.startsWith(this.root + path.sep); dir = path.dirname(dir)) {
      if (await rmdir(dir).then(() => false, () => true)) break
    }
    return { path: worktree.path, removed: true, reason: null }
  }

  private async inspectAll(): Promise<ManagedWorktree[]> {
    const tasks = this.tasks.list()
    const listing = new Map(tasks.flatMap((task) => task.repos.flatMap((repo) => (repo.worktreePath ? [[repo.worktreePath, task.id] as const] : []))))
    const byShortId = new Map(tasks.map((task) => [shortTaskId(task.id), task.id]))
    // Conversations keep their projects by real path.
    const conversations = this.conversations.list()
    const [found, busy] = await Promise.all([folders(this.root), this.tasks.inUse()])
    return Promise.all(found.map(async (folder) => {
      const taskId = listing.get(folder.dir) ?? byShortId.get(folder.shortId) ?? null
      const real = taskId ? folder.dir : await realpath(folder.dir).catch(() => folder.dir)
      const conversation = taskId ? undefined : conversations.find((each) => each.projectPaths.includes(real))
      const inUse = taskId !== null ? busy.has(taskId) : conversation?.chat?.turn === 'running'
      return { ...(await this.inspect(folder, taskId)), conversationId: conversation?.id ?? null, inUse }
    }))
  }

  private async inspect({ dir, planning }: Folder, taskId: string | null): Promise<ManagedWorktree> {
    const [status, commonDir, gitDir] = await Promise.all([
      gitOrNull(dir, ['status', '--porcelain=v2', '--branch']),
      gitOrNull(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      gitOrNull(dir, ['rev-parse', '--absolute-git-dir'])
    ])
    const lines = status?.split('\n') ?? []
    const head = lines.find((line) => line.startsWith('# branch.head '))?.slice('# branch.head '.length) ?? null
    const branch = head === '(detached)' ? null : head
    const [into, contained, locked, index, folder] = await Promise.all([
      originDefault(dir),
      branch ? Promise.resolve('branch') : gitOrNull(dir, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)']),
      gitDir ? mtime(path.join(gitDir, 'locked')).then((at) => at !== null) : Promise.resolve(false),
      gitDir ? mtime(path.join(gitDir, 'index')) : Promise.resolve(null),
      mtime(dir)
    ])
    const count = into ? await gitOrNull(dir, ['rev-list', '--count', `${into}..HEAD`]) : null
    return {
      path: dir,
      repo: commonDir ? (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir) : null,
      branch,
      taskId,
      planning,
      changes: status === null ? null : lines.filter((line) => line && !line.startsWith('#')).length,
      unmerged: into && count !== null ? { count: Number(count), into: into.replace(/^refs\/remotes\//, '') } : null,
      alone: status !== null && contained === null,
      inUse: false,
      locked,
      touchedAt: index ?? folder ?? this.now(),
      size: this.sizes.get(dir)?.bytes ?? null
    }
  }

  // One count at a time; a list read meanwhile gets the sizes known so far.
  private countSizes(paths: readonly string[]): void {
    const stale = paths.filter((dir) => {
      const known = this.sizes.get(dir)
      return !known || this.now() - known.at > SIZE_TTL_MS
    })
    if (this.counting || stale.length === 0) return
    this.counting = true
    void (async () => {
      for (const dir of stale) {
        const bytes = await diskUsage(dir)
        if (bytes !== null) this.sizes.set(dir, { bytes, at: this.now() })
      }
    })().finally(() => {
      this.counting = false
      this.changed()
    })
  }
}
