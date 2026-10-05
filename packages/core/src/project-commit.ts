import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommitPushResult, CommitResult, PushResult } from '@kando/protocol'
import { git, gitOrNull } from './git-changes'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

async function writeGit(dir: string, args: readonly string[], reason: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', dir, ...args])
  } catch (error) {
    throw new Rejection(reason, errorText(error))
  }
}

async function repoRoot(dir: string): Promise<{ root: string; branch: string }> {
  const root = await gitOrNull(dir, ['rev-parse', '--show-toplevel'])
  if (!root) throw new Rejection('repo-not-git')
  const branch = await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!branch) throw new Rejection('git-no-branch')
  return { root, branch }
}

// Everything in the repo staged and committed, without a shell, on the branch checked out.
export async function commitAll(dir: string, message: string): Promise<CommitResult> {
  const { root, branch } = await repoRoot(dir)
  if (!(await git(root, ['status', '--porcelain'])).trim()) throw new Rejection('git-no-changes')
  await writeGit(root, ['add', '-A'], 'git-commit-failed')
  await writeGit(root, ['commit', '-m', message], 'git-commit-failed')
  const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim()
  return { commit, branch }
}

// The branch checked out pushed to its upstream, or to origin, which it then tracks.
export async function pushBranch(dir: string): Promise<PushResult> {
  const { root, branch } = await repoRoot(dir)
  const tracked = await gitOrNull(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (tracked) {
    await writeGit(root, ['push'], 'git-push-failed')
  } else {
    if (!(await gitOrNull(root, ['remote', 'get-url', 'origin']))) throw new Rejection('git-no-remote')
    await writeGit(root, ['push', '--set-upstream', 'origin', 'HEAD'], 'git-push-failed')
  }
  const upstream = await gitOrNull(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  return { branch, upstream: upstream ?? `origin/${branch}` }
}

// One explicit UI action owns the whole operation. A failed push leaves the new local commit
// intact for a retry.
export async function commitAndPush(dir: string, message: string): Promise<CommitPushResult> {
  const { commit } = await commitAll(dir, message)
  const { branch, upstream } = await pushBranch(dir)
  return { commit, branch, upstream }
}
