import path from 'node:path'
import type { GitTarget, GitAction, GitResult, GitStatus, GitHistory, GitDetail, GitComparison, FileDiff } from '@kando/protocol'
import { checkGitOperation } from '@kando/protocol'
import type { TaskService } from './task-service'
import type { ConversationService } from './conversation-service'
import { git, gitOrNull } from './git-changes'
import { projectHead } from './workspace'
import { commitAll } from './project-commit'
import { Rejection } from './rejection'
import { commitRef, committedDiff, conflictFiles, filesBetween, gitOperation, logCommits, repositoryKey, writeGit } from './git-repository'

export class GitService {
  private readonly locked = new Set<string>()
  constructor(private readonly tasks: Pick<TaskService, 'get' | 'list' | 'isLaunching'>, private readonly conversations: Pick<ConversationService, 'get' | 'list' | 'recordGitChange' | 'isGitPending'>, private readonly changed: () => void = () => {}) {}

  private directory(target: GitTarget): string {
    if (target.kind === 'conversation') {
      const conversation = this.conversations.get(target.id)
      if (conversation.taskId) throw new Rejection('task-conversation', '请从任务的分支页管理 worktree。')
      if (conversation.projectPaths.includes(target.project)) return target.project
    } else {
      const repo = this.tasks.get(target.id).repos.find((repo) => repo.path === target.project)
      if (repo?.worktreePath) return repo.worktreePath
      if (repo) throw new Rejection('git-no-worktree', '任务 worktree 不存在，请先开始执行任务。')
    }
    throw new Rejection('repo-not-found', '项目不属于这个任务或会话。')
  }

  async guardAgent(dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      const key = await repositoryKey(dir)
      if (key && this.locked.has(key)) throw new Rejection('git-busy', 'Git 操作进行中，请完成后再发送消息。')
    }
  }

  async withRepositories<T>(dirs: readonly string[], run: () => Promise<T>): Promise<T> {
    const keys = [...new Set((await Promise.all(dirs.map(repositoryKey))).filter((key): key is string => key !== null))]
    if (keys.some((key) => this.locked.has(key))) throw new Rejection('git-busy', '这个仓库已有 Git 操作进行中。')
    keys.forEach((key) => this.locked.add(key))
    this.changed()
    try {
      for (const key of keys) if (await this.busy(key)) throw new Rejection('chat-busy')
      return await run()
    } finally { keys.forEach((key) => this.locked.delete(key)); this.changed() }
  }

  private async busy(key: string): Promise<boolean> {
    for (const task of this.tasks.list()) {
      if (this.tasks.isLaunching(task.id)) for (const repo of task.repos) if ((await repositoryKey(repo.worktreePath ?? repo.path) ?? await repositoryKey(repo.path)) === key) return true
    }
    for (const conversation of this.conversations.list(true)) {
      if (!conversation.starting && !this.conversations.isGitPending(conversation.id) && (!conversation.sessionId || conversation.chat?.turn === 'idle')) continue
      for (const dir of conversation.projectPaths) if (await repositoryKey(dir) === key) return true
    }
    return false
  }

  private async protectedRefs(key: string): Promise<Set<string>> {
    const refs = new Set<string>()
    for (const task of this.tasks.list()) {
      for (const repo of task.repos) {
        if (repo.branch && (await repositoryKey(repo.worktreePath ?? repo.path) ?? await repositoryKey(repo.path)) === key) refs.add(`refs/heads/${repo.branch}`)
      }
    }
    return refs
  }

  async status(target: GitTarget): Promise<GitStatus> {
    const dir = this.directory(target)
    const key = await repositoryKey(dir)
    const empty: GitStatus = { git: false, directory: dir, branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: 0, branches: [], remotes: [], blocker: null, operation: null, conflicts: [] }
    if (!key) return empty
    const [head, sha, listing, worktrees, remotes, protectedRefs, busy, operation, conflicts] = await Promise.all([
      projectHead(dir), gitOrNull(dir, ['rev-parse', 'HEAD']),
      git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(upstream)', 'refs/heads', 'refs/remotes']),
      git(dir, ['worktree', 'list', '--porcelain', '-z']), git(dir, ['remote']), this.protectedRefs(key), this.busy(key), gitOperation(dir), conflictFiles(dir)
    ])
    const holders = new Map<string, string>()
    let folder = ''
    for (const field of worktrees.split('\0')) {
      if (field.startsWith('worktree ')) folder = field.slice(9)
      if (field.startsWith('branch ')) holders.set(field.slice(7), folder)
    }
    return {
      ...empty, git: true, directory: await gitOrNull(dir, ['rev-parse', '--show-toplevel']) ?? dir, branch: head.detached ? null : head.branch, head: sha,
      upstream: head.upstream ?? null, ahead: head.ahead ?? 0, behind: head.behind ?? 0, changes: head.changes ?? 0,
      remotes: remotes.trim().split('\n').filter(Boolean), operation, conflicts,
      blocker: busy ? 'Agent 正在处理、等待批准或启动，请等这一轮结束。' : this.locked.has(key) ? 'Git 操作进行中。' : null,
      branches: listing.split('\n').filter(Boolean).flatMap((line) => {
        const [ref = '', sha = '', upstream = ''] = line.split('\0')
        const remote = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref)
        if (remote?.[2] === 'HEAD') return []
        return [{ ref, name: remote?.[2] ?? ref.slice('refs/heads/'.length), remote: remote?.[1] ?? null, sha, upstream: upstream || null, worktree: holders.get(ref) ?? null, protected: protectedRefs.has(ref) }]
      })
    }
  }

  async history(target: GitTarget, ref: string, offset: number, query: string, snapshot?: string[]): Promise<GitHistory> {
    const dir = this.directory(target)
    const head = await gitOrNull(dir, ['rev-parse', '--verify', 'HEAD'])
    const tips = snapshot
      ? snapshot.map((sha) => { if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Rejection('invalid-params', '分页起点必须是完整提交 SHA。'); return sha })
      : ref === 'all' ? [...new Set([...(await git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean), ...(head ? [head] : [])])] : head ? [await commitRef(dir, ref)] : []
    if (!tips.length) return { commits: [], tips, next: null }
    const commits: GitHistory['commits'] = []
    const needle = query.trim().toLowerCase()
    let scanned = offset
    let more = false
    // Bound work per request even when a search matches almost nothing.
    do {
      const pageStart = scanned
      const page = await logCommits(dir, tips, scanned)
      more = page.length > 100
      for (const commit of page.slice(0, 100)) {
        scanned++
        if (!needle || `${commit.subject}\n${commit.author}`.toLowerCase().includes(needle) || commit.sha.startsWith(needle)) commits.push(commit)
        if (commits.length === 100) { more = more || scanned < pageStart + page.length; break }
      }
    } while (more && commits.length < 100 && scanned - offset < 1000)
    return { commits, tips, next: more ? scanned : null }
  }

  async detail(target: GitTarget, ref: string, requestedParent?: string): Promise<GitDetail> {
    const dir = this.directory(target)
    const sha = await commitRef(dir, ref)
    const commit = (await logCommits(dir, ['--max-count=1', sha]))[0]
    if (!commit) throw new Rejection('branch-not-found')
    const parent = requestedParent ?? commit.parents[0] ?? null
    if (parent && !commit.parents.includes(parent)) throw new Rejection('invalid-params', '不是这个提交的父提交。')
    return { commit, parent, message: (await git(dir, ['show', '--no-patch', '--no-show-signature', '--format=%B', sha])).trimEnd(), files: await filesBetween(dir, parent, sha) }
  }

  async diff(target: GitTarget, base: string | null, ref: string, file: string): Promise<FileDiff> {
    const dir = this.directory(target)
    return committedDiff(dir, base ? await commitRef(dir, base) : null, await commitRef(dir, ref), file)
  }

  async compare(target: GitTarget, ref: string, direct: boolean): Promise<GitComparison> {
    const dir = this.directory(target)
    const [base, targetSha] = await Promise.all([commitRef(dir, 'HEAD'), commitRef(dir, ref)])
    const ancestor = await gitOrNull(dir, ['merge-base', base, targetSha])
    if (!direct && !ancestor) throw new Rejection('git-unrelated', '没有共同祖先，请选择两端直接比较。')
    const counts = (await git(dir, ['rev-list', '--left-right', '--count', `${base}...${targetSha}`])).trim().split(/\s+/).map(Number)
    const sides = new Map((await git(dir, ['rev-list', '--left-right', `${base}...${targetSha}`])).trim().split('\n').map((line) => [line.slice(1), line.startsWith('<') ? 'current' as const : 'target' as const]))
    const commits = (await logCommits(dir, [`${base}...${targetSha}`])).slice(0, 100).map((commit) => ({ ...commit, side: sides.get(commit.sha) }))
    return { base: direct ? base : ancestor ?? base, target: targetSha, ancestor, ahead: counts[0] ?? 0, behind: counts[1] ?? 0, commits, files: await filesBetween(dir, direct ? base : ancestor, targetSha) }
  }

  async execute(target: GitTarget, action: GitAction): Promise<GitResult> {
    const dir = this.directory(target)
    const key = await repositoryKey(dir)
    if (!key) throw new Rejection('repo-not-git')
    if (this.locked.has(key)) throw new Rejection('git-busy', '这个仓库已有 Git 操作进行中。')
    this.locked.add(key)
    this.changed()
    try {
      const status = await this.status(target)
      const blocker = checkGitOperation(target.kind, action, await this.busy(key), status)
      if (blocker) throw new Rejection(blocker)
      if (target.kind === 'task' && status.branch !== this.tasks.get(target.id).repos.find((repo) => repo.path === target.project)?.branch) throw new Rejection('git-task-branch', 'worktree 的实际分支与任务绑定不符，请先在终端修复。')
      const result = await this.perform(dir, status, action)
      const after = await projectHead(dir)
      const moved = ['switch', 'merge', 'pull', 'continue', 'abort', 'resolve'].includes(action.kind) || (action.kind === 'create' && action.checkout) || (action.kind === 'rename' && action.ref === `refs/heads/${status.branch}`)
      if (moved) {
        for (const conversation of this.conversations.list(true)) {
          for (const project of conversation.projectPaths) {
            const root = await gitOrNull(project, ['rev-parse', '--show-toplevel'])
            if (root === await gitOrNull(dir, ['rev-parse', '--show-toplevel'])) {
              await this.conversations.recordGitChange(conversation.id, project, after.branch ?? '分离 HEAD', action.kind === 'switch' || (action.kind === 'create' && action.checkout))
            }
          }
        }
      }
      return result
    } finally {
      this.locked.delete(key)
      this.changed()
    }
  }

  private async perform(dir: string, status: GitStatus, action: GitAction): Promise<GitResult> {
    const branchAt = (ref: string) => {
      const branch = status.branches.find((branch) => branch.ref === ref)
      if (!branch) throw new Rejection('branch-not-found')
      return branch
    }
    const validName = async (name: string) => {
      if (name.startsWith('-') || !await writeGit(dir, ['check-ref-format', '--branch', name]).then((output) => output === name, () => false)) throw new Rejection('invalid-branch-name')
    }
    const remoteAt = (remote: string) => {
      if (!status.remotes.includes(remote) || remote.startsWith('-')) throw new Rejection('git-no-remote', '请选择已配置的 remote。')
      return remote
    }
    const requireBranch = () => {
      if (!status.branch) throw new Rejection('git-no-branch', '请先检出一个本地分支。')
      return status.branch
    }
    const push = async (remote?: string, name?: string): Promise<GitResult> => {
      const branch = requireBranch()
      const tracked = status.branches.find((entry) => entry.ref === `refs/heads/${branch}`)?.upstream
      const match = tracked ? /^refs\/remotes\/([^/]+)\/(.+)$/.exec(tracked) : null
      const chosenRemote = remoteAt(remote ?? match?.[1] ?? 'origin')
      const chosenName = name ?? match?.[2] ?? branch
      await validName(chosenName)
      await writeGit(dir, ['push', '--set-upstream', chosenRemote, `refs/heads/${branch}:refs/heads/${chosenName}`])
      return { state: 'done', branch, upstream: `${chosenRemote}/${chosenName}` }
    }
    switch (action.kind) {
      case 'create': {
        await validName(action.name)
        const sha = await commitRef(dir, action.ref)
        await writeGit(dir, action.ref.startsWith('refs/remotes/') ? (action.checkout ? ['switch', '--track', '-c', action.name, action.ref] : ['branch', '--track', action.name, action.ref]) : action.checkout ? ['switch', '-c', action.name, sha] : ['branch', action.name, sha])
        return { state: 'done', branch: action.name }
      }
      case 'switch': {
        const branch = branchAt(action.ref)
        await validName(branch.name)
        if (branch.worktree && path.resolve(branch.worktree) !== path.resolve(status.directory)) throw new Rejection('branch-elsewhere')
        if (branch.remote) {
          const local = status.branches.find((entry) => entry.ref === `refs/heads/${branch.name}`)
          if (local && local.upstream !== branch.ref) throw new Rejection('git-tracking-conflict', '同名本地分支跟踪不同目标，请从远端分支新建其他名称的分支。')
          if (local?.worktree && path.resolve(local.worktree) !== path.resolve(status.directory)) throw new Rejection('branch-elsewhere')
          await writeGit(dir, local ? ['switch', branch.name] : ['switch', '--track', '-c', branch.name, `${branch.remote}/${branch.name}`])
        } else await writeGit(dir, ['switch', branch.name])
        return { state: 'done', branch: branch.name }
      }
      case 'rename':
      case 'delete': {
        const branch = branchAt(action.ref)
        await validName(branch.name)
        if (branch.protected) throw new Rejection('git-protected', '任务绑定的分支不能重命名或删除。')
        if (branch.worktree && (action.kind === 'delete' || path.resolve(branch.worktree) !== path.resolve(status.directory))) throw new Rejection('branch-elsewhere', '分支正在被 worktree 使用。')
        if (action.kind === 'rename') {
          if (branch.remote) throw new Rejection('git-operation-failed', '只支持重命名本地分支。')
          await validName(action.name)
          await writeGit(dir, ['branch', '-m', branch.name, action.name])
          return { state: 'done', branch: action.name }
        }
        if (branch.remote) {
          await writeGit(dir, ['push', remoteAt(branch.remote), '--delete', branch.name])
          if (await gitOrNull(dir, ['rev-parse', '--verify', branch.ref])) await writeGit(dir, ['update-ref', '-d', branch.ref, branch.sha])
        } else await writeGit(dir, ['branch', '-d', branch.name])
        break
      }
      case 'fetch':
        await writeGit(dir, action.remote ? ['fetch', remoteAt(action.remote)] : ['fetch', '--all'])
        break
      case 'pull': {
        requireBranch()
        if (!status.upstream) throw new Rejection('git-no-upstream', '当前分支没有 upstream，请先推送并建立跟踪。')
        const tracked = status.branches.find((entry) => entry.ref === `refs/heads/${status.branch}`)?.upstream
        const remote = tracked ? /^refs\/remotes\/([^/]+)\/(.+)$/.exec(tracked) : null
        if (!remote?.[1] || !remote[2]) throw new Rejection('git-no-upstream')
        await writeGit(dir, ['pull', '--ff-only', remoteAt(remote[1]), remote[2]])
        break
      }
      case 'push': return push(action.remote, action.name)
      case 'commit': {
        requireBranch()
        const commit = await commitAll(dir, action.message)
        if (!action.push) return { state: 'done', ...commit }
        try { return { ...await push(), commit: commit.commit } }
        catch (error) { throw new Rejection('git-push-after-commit-failed', `已提交 ${commit.commit}，但推送失败，本地提交已保留。${error instanceof Error ? error.message : ''}`) }
      }
      case 'merge': {
        requireBranch()
        await commitRef(dir, action.ref)
        try { await writeGit(dir, ['merge', '--no-edit', action.ref]) }
        catch (error) {
          if (await gitOperation(dir) === 'merge' && (await conflictFiles(dir)).length) return { state: 'conflicts' }
          throw error
        }
        break
      }
      case 'resolve': {
        if (!status.conflicts.includes(action.file)) throw new Rejection('file-not-changed', '文件不在当前冲突列表中。')
        await writeGit(dir, ['add', '--', action.file])
        break
      }
      case 'continue':
        if (status.conflicts.length) throw new Rejection('git-conflicts', '仍有未解决的冲突文件。')
        await writeGit(dir, ['commit', '--no-edit'])
        break
      case 'abort': await writeGit(dir, ['merge', '--abort']); break
    }
    return { state: 'done' }
  }
}
