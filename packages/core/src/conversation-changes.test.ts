import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderChanges, folderDiff, folderHead } from './conversation-changes'

describe('conversation changes', () => {
  let root: string
  let repo: string
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-folder-'))
    repo = path.join(root, 'app')
    mkdirSync(path.join(repo, 'web'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    writeFileSync(path.join(repo, 'web', 'page.ts'), 'page\n')
    git('add', '.')
    git('commit', '-q', '-m', 'before the conversation')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lists commits since the conversation started and whatever is uncommitted now', async () => {
    const start = await folderHead(repo)
    writeFileSync(path.join(repo, 'b.txt'), 'bee\n')
    git('add', 'b.txt')
    git('commit', '-q', '-m', 'agent commit')
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(path.join(repo, 'notes.md'), 'draft\n')

    const changes = await folderChanges(repo, start)
    expect(changes).toMatchObject({ branch: 'main', head: git('rev-parse', '--short=7', 'HEAD') })
    expect(changes.commits?.map((commit) => commit.subject)).toEqual(['agent commit'])
    expect(changes.files).toEqual([
      { path: 'a.txt', oldPath: null, kind: 'modified', additions: 1, deletions: 0 },
      { path: 'notes.md', oldPath: null, kind: 'untracked', additions: null, deletions: null }
    ])
  })

  it('has no commit list for a conversation that began before starts were recorded', async () => {
    expect((await folderChanges(repo, null)).commits).toBeNull()
  })

  it('reads the whole repo from a project folder inside it, with paths from the repo root', async () => {
    writeFileSync(path.join(repo, 'web', 'page.ts'), 'page\nmore\n')
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    const changes = await folderChanges(path.join(repo, 'web'), null)
    expect(changes.files.map((file) => file.path)).toEqual(['a.txt', 'web/page.ts'])
    expect((await folderDiff(path.join(repo, 'web'), 'web/page.ts')).diff).toContain('+more')
  })

  it('shows nothing for a folder outside git, and only new files in a repo with no commit yet', async () => {
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    expect(await folderChanges(plain, null)).toMatchObject({ head: null, commits: null, files: [] })

    const fresh = path.join(root, 'fresh')
    execFileSync('git', ['init', '-q', fresh])
    writeFileSync(path.join(fresh, 'first.txt'), 'first\n')
    expect((await folderChanges(fresh, null)).files).toMatchObject([{ path: 'first.txt', kind: 'untracked' }])
    expect((await folderDiff(fresh, 'first.txt')).diff).toContain('+first')
  })

  it('diffs only files with an uncommitted change', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    expect((await folderDiff(repo, 'a.txt')).diff).toContain('+two')
    await expect(folderDiff(repo, 'web/page.ts')).rejects.toMatchObject({ reason: 'file-not-changed' })
    await expect(folderDiff(repo, '../app/a.txt')).rejects.toMatchObject({ reason: 'file-not-changed' })
  })
})
