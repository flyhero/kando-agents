import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { MAX_FILE_PREVIEW_BYTES, type Conversation, type FileRead, type ResolvedFile } from '@kando/protocol'
import { findFiles } from './file-search'
import { Rejection } from './rejection'

type FileOwner = Pick<Conversation, 'workspacePath' | 'projectPaths'>

export function projectLocation(file: string, roots: readonly string[], paths = path): { root: string | null; relative: string | null } {
  const root = [...roots].sort((a, b) => b.length - a.length).find((root) => {
    const relative = paths.relative(root, file)
    return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
  })
  return root ? { root, relative: paths.relative(root, file) || '.' } : { root: null, relative: null }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

export class ConversationFiles {
  constructor(private readonly owner: (id: string) => FileOwner) {}

  async resolve(id: string, name: string): Promise<ResolvedFile | null> {
    const conversation = this.owner(id)
    const roots = conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]
    const expanded = name === '~' || /^~[\\/]/.test(name) ? path.join(homedir(), name.slice(2)) : name
    const absolute = path.isAbsolute(expanded)
    const candidates = absolute ? [path.normalize(expanded)] : roots.map((root) => path.resolve(root, expanded))
    const inspect = async (file: string): Promise<ResolvedFile | null> => {
      try {
        const info = await stat(file)
        if (!info.isFile() && !info.isDirectory()) return null
        return { path: file, ...projectLocation(file, roots), kind: info.isDirectory() ? 'directory' : 'file' }
      } catch (error) {
        if (missing(error)) return null
        throw new Rejection('file-unreadable', `无法访问文件：${file}`)
      }
    }
    for (const file of new Set(candidates)) {
      const found = await inspect(file)
      if (found) return found
    }
    if (!absolute && expanded === name) {
      for (const file of await findFiles(roots, name.replaceAll(path.sep, '/'))) {
        const found = await inspect(file)
        if (found) return found
      }
    }
    return null
  }

  async read(id: string, file: string): Promise<FileRead> {
    this.owner(id)
    if (!path.isAbsolute(file)) throw new Rejection('file-path-invalid', '读取文件需要绝对路径')
    try {
      const info = await stat(file)
      if (info.isDirectory()) return { kind: 'unavailable', reason: 'is-directory' }
      if (!info.isFile()) return { kind: 'unavailable', reason: 'binary' }
      if (info.size > MAX_FILE_PREVIEW_BYTES) return { kind: 'unavailable', reason: 'too-large' }
      // Nonblocking also protects against a regular file being replaced with a pipe before open.
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (!opened.isFile()) return { kind: 'unavailable', reason: opened.isDirectory() ? 'is-directory' : 'binary' }
        if (opened.size > MAX_FILE_PREVIEW_BYTES) return { kind: 'unavailable', reason: 'too-large' }
        const buffer = Buffer.alloc(MAX_FILE_PREVIEW_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length > MAX_FILE_PREVIEW_BYTES) return { kind: 'unavailable', reason: 'too-large' }
        const bytes = buffer.subarray(0, length)
        if (bytes.includes(0)) return { kind: 'unavailable', reason: 'binary' }
        try {
          return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        } catch {
          return { kind: 'unavailable', reason: 'binary' }
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { kind: 'unavailable', reason: missing(error) ? 'not-found' : 'unreadable' }
    }
  }
}
