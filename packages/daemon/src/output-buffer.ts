// The most recent output of a session, bounded. Chunks stay separate until a snapshot joins them,
// so each write costs its own length rather than the whole buffer's.
export class OutputBuffer {
  private chunks: string[] = []
  private size = 0
  // Characters written over the session's life; offsets count from the first one.
  private total = 0

  constructor(private readonly limit: number) {}

  get endOffset(): number {
    return this.total
  }

  append(data: string): number {
    const offset = this.total
    this.chunks.push(data)
    this.size += data.length
    this.total += data.length
    while (this.size > this.limit) {
      const first = this.chunks[0]!
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.slice(excess)
        this.size -= excess
      }
    }
    return offset
  }

  snapshot(): { buffer: string; bufferStart: number; endOffset: number } {
    const buffer = this.chunks.join('')
    this.chunks = buffer ? [buffer] : []
    return { buffer, bufferStart: this.total - buffer.length, endOffset: this.total }
  }
}
