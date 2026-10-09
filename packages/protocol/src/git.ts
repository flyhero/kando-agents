import { z } from 'zod'
import { ChangedFile } from './changes'

export const GitTarget = z.object({ kind: z.enum(['task', 'conversation']), id: z.string().min(1), project: z.string().min(1) })
export type GitTarget = z.infer<typeof GitTarget>
const Ref = z.string().min(1).max(500)
export const GitBranch = z.object({ ref: Ref, name: z.string(), remote: z.string().nullable(), sha: z.string(), upstream: z.string().nullable(), worktree: z.string().nullable(), protected: z.boolean() })
export type GitBranch = z.infer<typeof GitBranch>
export const GitCommit = z.object({ sha: z.string(), parents: z.array(z.string()), subject: z.string(), author: z.string(), date: z.string(), refs: z.array(z.string()), side: z.enum(['current', 'target']).optional() })
export type GitCommit = z.infer<typeof GitCommit>
export const GitHistory = z.object({ commits: z.array(GitCommit), tips: z.array(z.string()), next: z.number().int().nullable() })
export type GitHistory = z.infer<typeof GitHistory>
export const GitStatus = z.object({
  git: z.boolean(), directory: z.string(), branch: z.string().nullable(), head: z.string().nullable(),
  upstream: z.string().nullable(), ahead: z.number().int(), behind: z.number().int(), changes: z.number().int(),
  branches: z.array(GitBranch), remotes: z.array(z.string()), blocker: z.string().nullable(),
  operation: z.enum(['merge', 'other']).nullable(), conflicts: z.array(z.string())
})
export type GitStatus = z.infer<typeof GitStatus>
export const GitDetail = z.object({ commit: GitCommit, message: z.string(), parent: z.string().nullable(), files: z.array(ChangedFile) })
export type GitDetail = z.infer<typeof GitDetail>
export const GitComparison = z.object({ base: z.string(), target: z.string(), ancestor: z.string().nullable(), ahead: z.number(), behind: z.number(), commits: z.array(GitCommit), files: z.array(ChangedFile) })
export type GitComparison = z.infer<typeof GitComparison>
export const GitAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switch'), ref: Ref }),
  z.object({ kind: z.literal('create'), name: Ref, ref: Ref, checkout: z.boolean() }),
  z.object({ kind: z.literal('rename'), ref: Ref, name: Ref }),
  z.object({ kind: z.literal('delete'), ref: Ref }),
  z.object({ kind: z.literal('fetch'), remote: z.string().optional() }),
  z.object({ kind: z.literal('pull') }),
  z.object({ kind: z.literal('push'), remote: z.string().optional(), name: Ref.optional() }),
  z.object({ kind: z.literal('commit'), message: z.string().trim().min(1).max(10000), push: z.boolean() }),
  z.object({ kind: z.literal('merge'), ref: Ref }),
  z.object({ kind: z.literal('resolve'), file: z.string().min(1) }),
  z.object({ kind: z.literal('continue') }),
  z.object({ kind: z.literal('abort') })
])
export type GitAction = z.infer<typeof GitAction>
export const GitResult = z.object({ state: z.enum(['done', 'conflicts']), commit: z.string().optional(), branch: z.string().optional(), upstream: z.string().optional() })
export type GitResult = z.infer<typeof GitResult>

// Task worktrees keep their binding even while their agent is idle.
export function checkGitOperation(kind: GitTarget['kind'], action: GitAction, busy: boolean, status?: GitStatus): string | null {
  if (busy) return 'chat-busy'
  if (kind === 'task' && (action.kind === 'switch' || (action.kind === 'create' && action.checkout))) return 'task-conversation'
  if (!status) return null
  const mergeAction = ['resolve', 'continue', 'abort'].includes(action.kind)
  if (status.operation && !mergeAction) return 'git-in-progress'
  if (mergeAction && status.operation !== 'merge') return 'git-in-progress'
  if (['switch', 'pull', 'merge'].includes(action.kind) && status.changes > 0) return 'uncommitted-changes'
  if (['commit', 'push', 'pull', 'merge'].includes(action.kind) && !status.branch) return 'git-no-branch'
  if (action.kind === 'rename' || action.kind === 'delete') {
    const branch = status.branches.find((branch) => branch.ref === action.ref)
    if (branch?.protected) return 'git-protected'
    if (branch?.worktree && (action.kind === 'delete' || branch.worktree !== status.directory)) return 'branch-elsewhere'
  }
  return null
}
