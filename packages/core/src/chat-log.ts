import { appendFileSync, mkdirSync, openSync, readFileSync, closeSync, fstatSync, ftruncateSync, readSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ChatOption } from '@kando/protocol'
import type { ChatRecord } from './chat-driver'

const Level = z.enum(['info', 'warning', 'error']).catch('info')
const LogLine = z.discriminatedUnion('dir', [
  // end: the output offset just past this frame's line, so a restart knows where to pick up.
  z.object({ dir: z.literal('in'), at: z.number(), frame: z.unknown(), end: z.number().optional() }),
  z.object({ dir: z.literal('out'), at: z.number(), frame: z.unknown(), ref: z.string().optional() }),
  z.object({ dir: z.literal('note'), at: z.number(), level: Level, text: z.string() }),
  z.object({ dir: z.literal('option'), at: z.number(), option: ChatOption, value: z.string() }),
  z.object({ dir: z.literal('queue'), at: z.number(), text: z.string().nullable(), ref: z.string().optional() }),
  z.object({ dir: z.literal('exit'), at: z.number(), code: z.number().nullable(), stderr: z.string() })
])

export type LoggedRecord = ChatRecord & { end?: number }

export function parseChatRecord(line: string): LoggedRecord | null {
  try {
    const parsed = LogLine.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// A chat stage's record of what passed between Kando and the agent, one JSON line each. It is
// the stage's history: the chat view is rebuilt from it, so it is written before anything acts on it.
export class ChatLog {
  private ready = false

  constructor(readonly file: string) {}

  static of(sessionsRoot: string, conversationId: string, stageId: string): ChatLog {
    return new ChatLog(path.join(sessionsRoot, conversationId, 'stages', `${stageId}.jsonl`))
  }

  read(): { records: LoggedRecord[]; end: number } {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return { records: [], end: 0 }
    }
    const records = text.split('\n').flatMap((line) => {
      const record = line.trim() ? parseChatRecord(line) : null
      return record ? [record] : []
    })
    const end = records.reduce((max, record) => (record.dir === 'in' && record.end !== undefined ? Math.max(max, record.end) : max), 0)
    return { records, end }
  }

  append(records: readonly LoggedRecord[]): void {
    if (records.length === 0) return
    if (!this.ready) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      this.dropTornLine()
      this.ready = true
    }
    appendFileSync(this.file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 })
  }

  // A crash mid-write leaves half a line; appending after it would glue two records together.
  private dropTornLine(): void {
    let fd: number
    try {
      fd = openSync(this.file, 'r+')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size === 0) return
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] === 0x0a) return
      const content = readFileSync(this.file)
      ftruncateSync(fd, content.lastIndexOf(0x0a) + 1)
    } finally {
      closeSync(fd)
    }
  }
}
