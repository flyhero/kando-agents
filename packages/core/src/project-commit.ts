import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommitPushResult } from '@kando/protocol'
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

// One explicit UI action owns the whole operation: everything in the repo is staged, committed,
// and pushed without a shell. A failed push leaves the new local commit intact for a retry.
export async function commitAndPush(dir: string, message: string): Promise<CommitPushResult> {
  const root = await gitOrNull(dir, ['rev-parse', '--show-toplevel'])
  if (!root) throw new Rejection('repo-not-git')
  const branch = await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!branch) throw new Rejection('git-no-branch')
  if (!(await git(root, ['status', '--porcelain'])).trim()) throw new Rejection('git-no-changes')

  await writeGit(root, ['add', '-A'], 'git-commit-failed')
  await writeGit(root, ['commit', '-m', message], 'git-commit-failed')
  const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim()
  const tracked = await gitOrNull(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (tracked) {
    await writeGit(root, ['push'], 'git-push-failed')
  } else {
    if (!(await gitOrNull(root, ['remote', 'get-url', 'origin']))) throw new Rejection('git-no-remote')
    await writeGit(root, ['push', '--set-upstream', 'origin', 'HEAD'], 'git-push-failed')
  }
  const upstream = await gitOrNull(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  return { commit, branch, upstream: upstream ?? `origin/${branch}` }
}
