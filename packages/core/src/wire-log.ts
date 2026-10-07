import { appendFileSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { WireDirection, type WireEntry, type WireUsage } from '@kando/protocol'

export const WIRE_STAGE_LIMIT_BYTES = 50 * 1024 * 1024
// An image sent as base64 makes a line of megabytes; the rest of it says nothing a person reads.
export const WIRE_LINE_LIMIT_CHARS = 1024 * 1024
export const WIRE_KEEP_MS = 7 * 24 * 60 * 60_000
const PAGE_ENTRIES = 500
const PAGE_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

export type WireInput = { dir: WireDirection; text: string }

const Line = z.object({ at: z.number(), dir: WireDirection, text: z.string(), cut: z.number().int().optional() })

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size
  } catch {
    return null
  }
}

function endsInNewline(file: string, size: number): boolean {
  const fd = openSync(file, 'r')
  try {
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === NEWLINE
  } finally {
    closeSync(fd)
  }
}

// What passed between core and each chat agent's process, kept apart from the stage's chat log:
// that one is trimmed to what replaying the chat needs, this one keeps every line as it went, for
// the user to debug with. Off unless the user turns it on; each stage's file stops at a limit.
export class WireLog {
  private on = false
  // Bytes in each stage's file as last written, by path; null once it reached the limit.
  private readonly sizes = new Map<string, number | null>()

  constructor(
    private readonly sessionsRoot: string,
    private readonly added: (conversationId: string, stageId: string, entries: WireEntry[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  static directory(sessionsRoot: string, conversationId: string): string {
    return path.join(sessionsRoot, conversationId, 'wire')
  }

  get enabled(): boolean {
    return this.on
  }

  setEnabled(on: boolean): void {
    this.on = on
  }

  file(conversationId: string, stageId: string): string {
    return path.join(WireLog.directory(this.sessionsRoot, conversationId), `${stageId}.jsonl`)
  }

  record(conversationId: string, stageId: string, inputs: readonly WireInput[]): void {
    if (!this.on || inputs.length === 0) return
    const file = this.file(conversationId, stageId)
    let size = this.sizes.has(file) ? this.sizes.get(file) ?? null : this.open(file)
    if (size === null) return
    const at = this.now()
    const entries: WireEntry[] = []
    let text = ''
    for (const input of inputs) {
      const cut = input.text.length > WIRE_LINE_LIMIT_CHARS ? input.text.length : undefined
      const entry = { at, dir: input.dir, text: cut ? input.text.slice(0, WIRE_LINE_LIMIT_CHARS) : input.text, ...(cut ? { cut } : {}) }
      const line = `${JSON.stringify(entry)}\n`
      const bytes = Buffer.byteLength(line)
      if (size + bytes > WIRE_STAGE_LIMIT_BYTES) {
        const note = { at, dir: 'note' as const, text: `这一段的原始数据已经到了 ${WIRE_STAGE_LIMIT_BYTES / 1024 / 1024} MB 的上限，之后的不再记录` }
        entries.push({ pos: size, ...note })
        text += `${JSON.stringify(note)}\n`
        size = null
        break
      }
      entries.push({ pos: size, ...entry })
      text += line
      size += bytes
    }
    appendFileSync(file, text, { mode: 0o600 })
    this.sizes.set(file, size)
    this.added(conversationId, stageId, entries)
  }

  // A file left by a crash mid-line gets its newline first, so the next entry starts a line of its own.
  private open(file: string): number | null {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const size = sizeOf(file) ?? 0
    if (size >= WIRE_STAGE_LIMIT_BYTES) {
      this.sizes.set(file, null)
      return null
    }
    if (size > 0 && !endsInNewline(file, size)) {
      appendFileSync(file, '\n')
      return size + 1
    }
    return size
  }

  // The stage's file size, null when it has none.
  bytes(conversationId: string, stageId: string): number | null {
    return sizeOf(this.file(conversationId, stageId))
  }

  // The stages of the conversation with a file, as their files say: one whose start failed has
  // no stage left in the store, and is the one most worth looking at.
  stages(conversationId: string): Array<{ stageId: string; bytes: number; createdAt: number }> {
    const directory = WireLog.directory(this.sessionsRoot, conversationId)
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    return names.filter((name) => name.endsWith('.jsonl')).flatMap((name) => {
      try {
        const stat = statSync(path.join(directory, name))
        return [{ stageId: name.slice(0, -'.jsonl'.length), bytes: stat.size, createdAt: stat.birthtimeMs || stat.mtimeMs }]
      } catch {
        return []
      }
    })
  }

  // The newest entries before `before`, oldest first, up to a count and a size (always at least
  // one); before is where the next older page ends, null when none is left.
  page(conversationId: string, stageId: string, before?: number): { entries: WireEntry[]; before: number | null } {
    let data: Buffer
    try {
      data = readFileSync(this.file(conversationId, stageId))
    } catch {
      return { entries: [], before: null }
    }
    const limit = Math.min(before ?? data.length, data.length)
    const starts: number[] = []
    for (let pos = 0; pos < limit; pos = data.indexOf(NEWLINE, pos) + 1 || data.length) starts.push(pos)
    const entries: WireEntry[] = []
    let bytes = 0
    let first = starts.length
    for (let index = starts.length - 1; index >= 0; index--) {
      const start = starts[index] ?? 0
      const end = Math.min(starts[index + 1] ?? limit, limit)
      if (entries.length >= PAGE_ENTRIES || (entries.length > 0 && bytes + end - start > PAGE_BYTES)) break
      first = index
      bytes += end - start
      const entry = this.parse(data.subarray(start, end).toString('utf8'), start)
      if (entry) entries.push(entry)
    }
    entries.reverse()
    return { entries, before: first > 0 ? (starts[first] ?? null) : null }
  }

  private parse(line: string, pos: number): WireEntry | null {
    if (!line.trim()) return null
    try {
      const parsed = Line.safeParse(JSON.parse(line))
      return parsed.success ? { pos, ...parsed.data } : null
    } catch {
      return null
    }
  }

  usage(): WireUsage {
    return this.files().reduce((sum, file) => ({ files: sum.files + 1, bytes: sum.bytes + (sizeOf(file) ?? 0) }), { files: 0, bytes: 0 })
  }

  clear(): WireUsage {
    for (const directory of this.directories()) rmSync(directory, { recursive: true, force: true })
    this.sizes.clear()
    return this.usage()
  }

  // Files untouched for longer than keepMs go; a stage still writing has touched its own lately.
  prune(keepMs: number = WIRE_KEEP_MS): void {
    const cutoff = this.now() - keepMs
    for (const file of this.files()) {
      try {
        if (statSync(file).mtimeMs < cutoff) {
          rmSync(file, { force: true })
          this.sizes.delete(file)
        }
      } catch {
        // Gone already.
      }
    }
  }

  private directories(): string[] {
    let conversations: string[]
    try {
      conversations = readdirSync(this.sessionsRoot)
    } catch {
      return []
    }
    return conversations.map((id) => WireLog.directory(this.sessionsRoot, id)).filter((directory) => sizeOf(directory) !== null)
  }

  private files(): string[] {
    return this.directories().flatMap((directory) => {
      try {
        return readdirSync(directory).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(directory, name))
      } catch {
        return []
      }
    })
  }
}
