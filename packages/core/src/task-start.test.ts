import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { originDefault, repoStartOptions, resolveStart } from './task-start'

describe('task starts', () => {
  let root: string
  let remote: string
  let clone: string
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = (dir: string, message: string) => {
    git(dir, 'commit', '-q', '--allow-empty', '-m', message)
    return git(dir, 'rev-parse', 'HEAD')
  }
  // Someone else pushes to origin after the clone was made.
  let pushes = 0
  const pushFromElsewhere = (branch: string, message: string) => {
    const other = path.join(root, `other-${++pushes}`)
    git(root, 'clone', '-q', remote, other)
    const known = git(other, 'branch', '-r', '--list', `origin/${branch}`)
    git(other, 'checkout', '-q', '-B', branch, known ? `origin/${branch}` : 'HEAD')
    const sha = commit(other, message)
    git(other, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
    return sha
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-start-'))
    remote = path.join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', '-b', 'main', remote)
    const seed = path.join(root, 'seed')
    git(root, 'init', '-q', '-b', 'main', seed)
    commit(seed, 'init')
    git(seed, 'push', '-q', remote, 'main')
    clone = path.join(root, 'clone')
    git(root, 'clone', '-q', remote, clone)
    // The user works on a branch of their own, which is not where a task should start.
    git(clone, 'checkout', '-q', '-b', 'feature/login')
    commit(clone, 'local work')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('starts from origin\'s default branch, brought up to date first', async () => {
    const latest = pushFromElsewhere('main', 'pushed later')
    expect(git(clone, 'rev-parse', 'origin/main')).not.toBe(latest)
    expect(await resolveStart(clone, null, null, 7)).toEqual({
      commit: latest,
      start: { ref: 'origin/main', commit: latest, note: null, at: 7 },
      head: false
    })
  })

  it('looks for origin/HEAD, then origin/main, then origin/master', async () => {
    expect(await originDefault(clone)).toBe('refs/remotes/origin/main')
    git(clone, 'remote', 'set-head', 'origin', '--delete')
    expect(await originDefault(clone)).toBe('refs/remotes/origin/main')
    git(clone, 'update-ref', 'refs/remotes/origin/master', 'origin/main')
    git(clone, 'update-ref', '-d', 'refs/remotes/origin/main')
    expect(await originDefault(clone)).toBe('refs/remotes/origin/master')
    git(clone, 'update-ref', 'refs/remotes/origin/develop', 'origin/master')
    git(clone, 'remote', 'set-head', 'origin', 'develop')
    expect(await originDefault(clone)).toBe('refs/remotes/origin/develop')
  })

  it('starts from what the repo has checked out when there is no origin, and says so', async () => {
    const local = path.join(root, 'local')
    git(root, 'init', '-q', '-b', 'trunk', local)
    const head = commit(local, 'only')
    expect((await resolveStart(local, null, null, 1)).start).toEqual({ ref: 'trunk', commit: head, note: 'no-remote-default', at: 1 })
  })

  it('uses the copy of origin it has when fetching fails, and says so', async () => {
    const known = git(clone, 'rev-parse', 'origin/main')
    git(clone, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'))
    expect((await resolveStart(clone, null, null, 1)).start).toEqual({ ref: 'origin/main', commit: known, note: 'fetch-failed', at: 1 })
  })

  it('starts where the task picked: what is checked out, a local branch, or a remote one fetched first', async () => {
    expect((await resolveStart(clone, 'HEAD', null, 1)).start).toMatchObject({ ref: 'feature/login', commit: git(clone, 'rev-parse', 'HEAD'), note: null })
    git(clone, 'branch', 'release/2.4', 'origin/main')
    expect((await resolveStart(clone, 'refs/heads/release/2.4', null, 1)).start).toMatchObject({ ref: 'release/2.4', note: null })
    pushFromElsewhere('hotfix', 'first')
    git(clone, 'fetch', '-q', 'origin')
    const latest = pushFromElsewhere('hotfix', 'second')
    expect((await resolveStart(clone, 'refs/remotes/origin/hotfix', null, 1)).start).toMatchObject({ ref: 'origin/hotfix', commit: latest, note: null })
  })

  it('refuses a picked branch the repo does not have, without asking the network', async () => {
    git(clone, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'))
    await expect(resolveStart(clone, 'refs/remotes/origin/nope', null, 1)).rejects.toMatchObject({ reason: 'start-not-found' })
    await expect(resolveStart(clone, 'refs/heads/nope', null, 1)).rejects.toMatchObject({ reason: 'start-not-found' })
  })

  it('stacks on a dependency\'s branch when nothing is picked', async () => {
    git(clone, 'branch', 'kando/aaaa-dep', 'HEAD')
    expect((await resolveStart(clone, null, 'kando/aaaa-dep', 1)).start).toMatchObject({ ref: 'kando/aaaa-dep', note: null })
  })

  it('offers local branches, then remote ones, with what starts the branch when nothing is picked', async () => {
    pushFromElsewhere('hotfix', 'fix')
    git(clone, 'fetch', '-q', 'origin')
    const options = await repoStartOptions(clone, clone, null)
    expect(options).toMatchObject({ path: clone, git: true, current: 'feature/login', fallback: 'refs/remotes/origin/main', stacked: false })
    expect(options.refs.slice(0, 2).sort()).toEqual(['refs/heads/feature/login', 'refs/heads/main'])
    expect(options.refs.slice(2).sort()).toEqual(['refs/remotes/origin/hotfix', 'refs/remotes/origin/main'])
    expect(await repoStartOptions(clone, clone, 'kando/aaaa-dep')).toMatchObject({ fallback: 'refs/heads/kando/aaaa-dep', stacked: true })
    expect(await repoStartOptions('/notes', null, null)).toEqual({ path: '/notes', git: false, current: null, fallback: null, stacked: false, refs: [] })
  })
})
