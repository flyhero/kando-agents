import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitAndPush } from './project-commit'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

describe('commitAndPush', () => {
  let root: string
  let repo: string
  let remote: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-commit-'))
    repo = path.join(root, 'repo')
    remote = path.join(root, 'remote.git')
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(repo, 'config', 'user.name', 'Kando Test')
    git(repo, 'config', 'user.email', 'kando@example.com')
    git(repo, 'remote', 'add', 'origin', remote)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('commits every change and establishes an upstream before pushing', async () => {
    writeFileSync(path.join(repo, 'one.txt'), 'one\n')
    const result = await commitAndPush(repo, 'feat: add one')

    expect(result).toMatchObject({ branch: 'main', upstream: 'origin/main' })
    expect(result.commit).toMatch(/^[0-9a-f]+$/)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: add one')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'refs/heads/main'))
  })

  it('pushes later commits through the existing upstream', async () => {
    writeFileSync(path.join(repo, 'one.txt'), 'one\n')
    await commitAndPush(repo, 'feat: add one')
    writeFileSync(path.join(repo, 'two.txt'), 'two\n')

    const result = await commitAndPush(repo, 'feat: add two')

    expect(result.upstream).toBe('origin/main')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'refs/heads/main'))
  })

  it('refuses an empty worktree and a detached head', async () => {
    writeFileSync(path.join(repo, 'one.txt'), 'one\n')
    await commitAndPush(repo, 'feat: add one')
    await expect(commitAndPush(repo, 'empty')).rejects.toMatchObject({ reason: 'git-no-changes' })
    git(repo, 'checkout', '--detach', '-q')
    writeFileSync(path.join(repo, 'two.txt'), 'two\n')
    await expect(commitAndPush(repo, 'detached')).rejects.toMatchObject({ reason: 'git-no-branch' })
  })
})
