export type FramedLine = { text: string; end: number }

// Splits a process's output into lines, knowing where in the stream each chunk starts: chunks can
// arrive twice (a replayed buffer overlapping live output) or with a hole (output lost while core
// was down). `received` is the offset of the next character it expects.
export class LineFramer {
  private partial = ''
  // After a hole, the rest of the line it cut into is garbage until the next newline.
  private skipping = false

  constructor(private received: number) {}

  feed(offset: number, data: string): { lines: FramedLine[]; gap: boolean } {
    const lines: FramedLine[] = []
    if (offset + data.length <= this.received) {
      return { lines, gap: false }
    }
    const gap = offset > this.received
    if (gap) {
      this.partial = ''
      this.skipping = true
    }
    let start = Math.max(0, this.received - offset)
    this.received = offset + data.length
    while (start < data.length) {
      const newline = data.indexOf('\n', start)
      if (newline === -1) {
        if (!this.skipping) this.partial += data.slice(start)
        break
      }
      if (this.skipping) {
        this.skipping = false
      } else {
        lines.push({ text: this.partial + data.slice(start, newline), end: offset + newline + 1 })
      }
      this.partial = ''
      start = newline + 1
    }
    return { lines, gap }
  }

  // The last line when the process ends without a newline after it.
  flush(): FramedLine | null {
    const text = this.partial
    this.partial = ''
    return text && !this.skipping ? { text, end: this.received } : null
  }
}
