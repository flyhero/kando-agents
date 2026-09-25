import { appendFileSync, existsSync, mkdirSync, openSync, readSync, statSync, closeSync } from 'node:fs'
import path from 'node:path'

const CHUNK = 65536

export class TerminalTranscript {
  constructor(private readonly root: string) {}

  private file(id: string): string { return path.join(this.root, id, 'terminal.log') }

  append(id: string, data: string): void {
    mkdirSync(path.dirname(this.file(id)), { recursive: true, mode: 0o700 })
    appendFileSync(this.file(id), data, 'utf8')
  }

  marker(id: string, label: string): void {
    this.append(id, `\r\n\x1b[2m── ${label} ──\x1b[0m\r\n`)
  }

  read(id: string, offset: number, length: number): { data: string; nextOffset: number; totalBytes: number } {
    const file = this.file(id)
    if (!existsSync(file)) return { data: '', nextOffset: 0, totalBytes: 0 }
    const totalBytes = statSync(file).size
    const start = Math.min(offset, totalBytes)
    const size = Math.min(length, CHUNK, totalBytes - start)
    const bytes = Buffer.alloc(size)
    const fd = openSync(file, 'r')
    try {
      const count = readSync(fd, bytes, 0, size, start)
      return { data: bytes.subarray(0, count).toString('base64'), nextOffset: start + count, totalBytes }
    } finally {
      closeSync(fd)
    }
  }
}
