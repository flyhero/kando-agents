import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { START_HEAD, type RepoStartOptions, type StartNote, type TaskStart } from '@kando/protocol'
import { gitOrNull } from './git-changes'
import { Rejection } from './rejection'

const execFileAsync = promisify(execFile)

// A fetch stuck on the network or a credential prompt must not hold a task's start for long.
const FETCH_TIMEOUT_MS = 20_000
// After what origin/HEAD names, the usual names for origin's default branch, in this order.
const DEFAULT_BRANCHES = ['refs/remotes/origin/main', 'refs/remotes/origin/master']
const MAX_REFS = 300

// `head`: the start is whatever the project has checked out, which can be read where it is.
export type ResolvedStart = { commit: string; start: TaskStart; head: boolean }

async function commitOf(dir: string, ref: string): Promise<string | null> {
  return gitOrNull(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

// Origin's default branch by its full name, from what the repo already knows of origin.
export async function originDefault(dir: string): Promise<string | null> {
  const head = await gitOrNull(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  for (const ref of [head, ...DEFAULT_BRANCHES]) {
    if (ref && (await commitOf(dir, ref))) return ref
  }
  return null
}

// The branch the project has checked out, or its short commit when detached.
async function headName(dir: string): Promise<string | null> {
  return (await gitOrNull(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? gitOrNull(dir, ['rev-parse', '--short', 'HEAD'])
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

// Brings one remote-tracking branch up to date, and nothing else: no tags, no other branches. The
// remote must be one the repo has, and `--` keeps git from reading it as an option.
async function fetched(dir: string, ref: string): Promise<boolean> {
  const [remote, ...rest] = shortName(ref).split('/')
  const branch = rest.join('/')
  const remotes = (await gitOrNull(dir, ['remote']))?.split('\n') ?? []
  if (!remote || !branch || !remotes.includes(remote)) return false
  try {
    await execFileAsync('git', ['-C', dir, 'fetch', '--no-tags', '--quiet', '--', remote, `+refs/heads/${branch}:${ref}`], {
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    return true
  } catch {
    return false
  }
}

async function started(dir: string, ref: string, name: string | null, note: StartNote | null, at: number): Promise<ResolvedStart> {
  const commit = await commitOf(dir, ref)
  if (!commit) throw new Rejection('start-not-found', `${name ?? ref} is not a commit in ${dir}`)
  return { commit, start: { ref: name ?? commit.slice(0, 7), commit, note, at }, head: ref === START_HEAD }
}

// Where a task's new branch starts: what the task picked, else the one branch a dependency left
// in the repo, else origin's default branch brought up to date, else HEAD. A remote branch that
// cannot be fetched starts from the copy the repo has, and says so.
export async function resolveStart(dir: string, picked: string | null, stacked: string | null, at: number): Promise<ResolvedStart> {
  if (picked === START_HEAD) return started(dir, START_HEAD, await headName(dir), null, at)
  if (picked) {
    // Checked before fetching, so only a ref the repo has reaches the network.
    if (!(await commitOf(dir, picked))) throw new Rejection('start-not-found', `${shortName(picked)} is not a branch in ${dir}`)
    const note = picked.startsWith('refs/remotes/') && !(await fetched(dir, picked)) ? 'fetch-failed' : null
    return started(dir, picked, shortName(picked), note, at)
  }
  if (stacked) return started(dir, `refs/heads/${stacked}`, stacked, null, at)
  const origin = await originDefault(dir)
  if (!origin) return started(dir, START_HEAD, await headName(dir), 'no-remote-default', at)
  return started(dir, origin, shortName(origin), (await fetched(dir, origin)) ? null : 'fetch-failed', at)
}

async function refsUnder(dir: string, prefix: string): Promise<string[]> {
  const output = await gitOrNull(dir, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_REFS}`, '--format=%(refname)', prefix])
  return (output?.split('\n') ?? []).filter((ref) => ref && !ref.endsWith('/HEAD'))
}

// What a repo could start from; `dir` is its top level, null for a plain folder.
export async function repoStartOptions(path: string, dir: string | null, stacked: string | null): Promise<RepoStartOptions> {
  if (!dir) return { path, git: false, current: null, fallback: null, stacked: false, refs: [] }
  const [current, fallback, local, remote] = await Promise.all([
    headName(dir),
    stacked ? Promise.resolve(`refs/heads/${stacked}`) : originDefault(dir),
    refsUnder(dir, 'refs/heads'),
    refsUnder(dir, 'refs/remotes')
  ])
  return { path, git: true, current, fallback, stacked: stacked !== null, refs: [...local, ...remote] }
}
