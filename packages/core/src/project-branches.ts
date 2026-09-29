import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectBranches } from '@kando/protocol'
import { gitOrNull } from './git-changes'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

const MAX_REFS = 300

async function refsUnder(dir: string, prefix: string): Promise<string[]> {
  const output = await gitOrNull(dir, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_REFS}`, '--format=%(refname)', prefix])
  return (output?.split('\n') ?? []).filter((ref) => ref && !ref.endsWith('/HEAD'))
}

// Branches checked out in the repo's other worktrees, by full name, to the worktree's folder.
async function checkedOutElsewhere(dir: string, topLevel: string): Promise<Record<string, string>> {
  const listing = (await gitOrNull(dir, ['worktree', 'list', '--porcelain'])) ?? ''
  const elsewhere: Record<string, string> = {}
  for (const entry of listing.split('\n\n')) {
    const folder = /^worktree (.+)$/m.exec(entry)?.[1]
    const branch = /^branch (.+)$/m.exec(entry)?.[1]
    if (folder && branch && path.resolve(folder) !== path.resolve(topLevel)) elsewhere[branch] = folder
  }
  return elsewhere
}

// Uncommitted changes to tracked files; untracked ones go along with a switch, as git does.
async function trackedChanges(dir: string): Promise<number> {
  const status = await gitOrNull(dir, ['status', '--porcelain', '--untracked-files=no'])
  return status ? status.split('\n').filter(Boolean).length : 0
}

export async function projectBranches(dir: string): Promise<Omit<ProjectBranches, 'path' | 'sharedWith'>> {
  const topLevel = await gitOrNull(dir, ['rev-parse', '--show-toplevel'])
  if (!topLevel) return { git: false, branch: null, changes: 0, refs: [], elsewhere: {} }
  const [branch, changes, local, remote, elsewhere] = await Promise.all([
    gitOrNull(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    trackedChanges(dir),
    refsUnder(dir, 'refs/heads'),
    refsUnder(dir, 'refs/remotes'),
    checkedOutElsewhere(dir, topLevel)
  ])
  return { git: true, branch, changes, refs: [...local, ...remote], elsewhere }
}

async function exists(dir: string, ref: string): Promise<boolean> {
  return (await gitOrNull(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null
}

async function gitSwitch(dir: string, args: readonly string[]): Promise<void> {
  try {
    await execFileAsync('git', ['-C', dir, 'switch', '--quiet', ...args])
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new Rejection('branch-switch-failed', stderr || 'git switch failed')
  }
}

// Checks out a branch by its full name, returning the local branch now checked out. A remote one
// is checked out as the local branch of its name, made to track it when there is none yet.
// Changes to tracked files refuse it: nothing of the user's is carried off or overwritten.
export async function switchProjectBranch(dir: string, ref: string): Promise<string> {
  const remote = /^refs\/remotes\/([^/\s]+)\/(\S+)$/.exec(ref)
  const local = /^refs\/heads\/(\S+)$/.exec(ref)?.[1] ?? remote?.[2]
  if (!local || !(await exists(dir, ref))) throw new Rejection('branch-not-found', `${ref} is not a branch here`)
  if ((await trackedChanges(dir)) > 0) throw new Rejection('uncommitted-changes', 'commit or stash the changes first')
  // Asked of git's worktree list rather than read from its refusal, which speaks the user's language.
  const topLevel = await gitOrNull(dir, ['rev-parse', '--show-toplevel'])
  const holder = topLevel ? (await checkedOutElsewhere(dir, topLevel))[`refs/heads/${local}`] : undefined
  if (holder) throw new Rejection('branch-elsewhere', `${local} is checked out in ${holder}`)
  // Branch names never start with "-" (git refuses them), so none reads as an option.
  if (remote && !(await exists(dir, `refs/heads/${local}`))) await gitSwitch(dir, ['--track', `${remote[1]}/${local}`])
  else await gitSwitch(dir, [local])
  return local
}

// A new branch at HEAD, checked out: uncommitted changes stay in the folder and go with it.
export async function createProjectBranch(dir: string, name: string): Promise<string> {
  const valid = await execFileAsync('git', ['-C', dir, 'check-ref-format', '--branch', name]).then(() => !name.startsWith('-'), () => false)
  if (!valid) throw new Rejection('invalid-branch-name', `${name} is not a branch name`)
  if (await exists(dir, `refs/heads/${name}`)) throw new Rejection('branch-name-taken', `${name} already exists`)
  await gitSwitch(dir, ['-c', name])
  return name
}
