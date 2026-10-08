import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILE_PREVIEW_BYTES } from '@kando/protocol'
import { ConversationFiles, projectLocation } from './conversation-files'

describe('conversation files', () => {
  let root: string
  let primary: string
  let extra: string
  let files: ConversationFiles
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kando-preview-'))
    primary = path.join(root, 'primary')
    extra = path.join(root, 'extra')
    await Promise.all([mkdir(path.join(primary, 'src/deep'), { recursive: true }), mkdir(extra)])
    execFileSync('git', ['init', '-q'], { cwd: primary })
    files = new ConversationFiles(() => ({ workspacePath: primary, projectPaths: [primary, extra] }))
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('resolves exact paths in project order, including an extra worktree and spaced Unicode names', async () => {
    await Promise.all([writeFile(path.join(primary, '同名 文件.ts'), 'primary'), writeFile(path.join(extra, '同名 文件.ts'), 'extra'), writeFile(path.join(extra, 'only.md'), '')])
    expect(await files.resolve('chat', '同名 文件.ts')).toEqual({ path: path.join(primary, '同名 文件.ts'), root: primary, relative: '同名 文件.ts', kind: 'file' })
    expect(await files.resolve('chat', 'only.md')).toMatchObject({ path: path.join(extra, 'only.md'), root: extra })
    expect(await files.resolve('chat', '../extra/only.md')).toMatchObject({ path: path.join(extra, 'only.md') })
  })

  it('finds a bare name below the project root with the existing shallowest match rule', async () => {
    await Promise.all([writeFile(path.join(primary, 'src/deep/a.ts'), ''), writeFile(path.join(primary, 'src/a.ts'), '')])
    expect(await files.resolve('chat', 'a.ts')).toMatchObject({ path: path.join(primary, 'src/a.ts') })
    expect(await files.resolve('chat', 'missing.ts')).toBeNull()
  })

  it('supports managed workspaces, directories, home and absolute files outside the projects', async () => {
    const managed = new ConversationFiles(() => ({ workspacePath: primary, projectPaths: [] }))
    await writeFile(path.join(primary, 'managed.md'), 'managed')
    await writeFile(path.join(root, 'outside.txt'), 'outside')
    expect(await managed.resolve('chat', 'managed.md')).toMatchObject({ path: path.join(primary, 'managed.md') })
    expect(await files.resolve('chat', 'src')).toMatchObject({ kind: 'directory' })
    expect(await files.resolve('chat', '~')).toMatchObject({ path: homedir(), kind: 'directory' })
    expect(await files.resolve('chat', path.join(root, 'outside.txt'))).toMatchObject({ root: null, relative: null })
  })

  it('reads UTF-8 text and empty files, and distinguishes missing files and directories', async () => {
    const text = path.join(primary, 'text.md')
    const empty = path.join(primary, 'empty.txt')
    await Promise.all([writeFile(text, '你好\ncontent\n'), writeFile(empty, '')])
    expect(await files.read('chat', text)).toEqual({ kind: 'text', text: '你好\ncontent\n' })
    expect(await files.read('chat', empty)).toEqual({ kind: 'text', text: '' })
    expect(await files.read('chat', path.join(primary, 'gone'))).toEqual({ kind: 'unavailable', reason: 'not-found' })
    expect(await files.read('chat', primary)).toEqual({ kind: 'unavailable', reason: 'is-directory' })
  })

  it('rejects binary bytes and invalid UTF-8 instead of decoding them as text', async () => {
    for (const [index, buffer] of [Buffer.from([0, 65]), Buffer.from([0xff, 0xfe])].entries()) {
      const file = path.join(primary, `binary-${index}`)
      await writeFile(file, buffer)
      expect(await files.read('chat', file)).toEqual({ kind: 'unavailable', reason: 'binary' })
    }
  })

  it('allows exactly the preview limit and refuses larger files without truncating them', async () => {
    const file = path.join(primary, 'large.txt')
    await writeFile(file, 'a'.repeat(MAX_FILE_PREVIEW_BYTES))
    const read = await files.read('chat', file)
    expect(read.kind === 'text' && read.text.length).toBe(MAX_FILE_PREVIEW_BYTES)
    await writeFile(file, 'a'.repeat(MAX_FILE_PREVIEW_BYTES + 1))
    expect(await files.read('chat', file)).toEqual({ kind: 'unavailable', reason: 'too-large' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable files', async () => {
    const file = path.join(primary, 'private.txt')
    await writeFile(file, 'private')
    await chmod(file, 0)
    expect(await files.read('chat', file)).toEqual({ kind: 'unavailable', reason: 'unreadable' })
  })

  it('checks the owning conversation and requires an absolute read path', async () => {
    await expect(files.read('chat', 'a.ts')).rejects.toThrow('绝对路径')
    const deleted = new ConversationFiles(() => { throw new Error('conversation not found') })
    await expect(deleted.read('deleted', primary)).rejects.toThrow('conversation not found')
    await expect(deleted.resolve('deleted', primary)).rejects.toThrow('conversation not found')
  })
})

it('computes project boundaries for Windows drive and UNC paths', () => {
  expect(projectLocation('C:\\repo\\src\\a.ts', ['C:\\repo'], path.win32)).toEqual({ root: 'C:\\repo', relative: 'src\\a.ts' })
  expect(projectLocation('C:\\repo-other\\a.ts', ['C:\\repo'], path.win32)).toEqual({ root: null, relative: null })
  expect(projectLocation('\\\\host\\share\\repo\\a.ts', ['\\\\host\\share\\repo'], path.win32).relative).toBe('a.ts')
})
