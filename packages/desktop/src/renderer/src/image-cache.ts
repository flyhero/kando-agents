type Entry = { url: Promise<string | null>; refs: number; used: number; failed: boolean }

// Object URLs for images, shared by everything showing the same one. Requests for an id are
// merged, and a URL is released only once nothing shows it and it has aged out, so a thumbnail
// scrolling away and back does not fetch again.
export class ImageCache {
  private readonly entries = new Map<string, Entry>()
  private clock = 0

  constructor(
    private readonly load: (id: string) => Promise<string | null>,
    private readonly revoke: (url: string) => void,
    private readonly keep: number = 40
  ) {}

  acquire(id: string): { url: Promise<string | null>; release(): void } {
    let entry = this.entries.get(id)
    if (!entry) {
      const created: Entry = { url: Promise.resolve(null), refs: 0, used: 0, failed: false }
      created.url = this.load(id)
        .catch(() => null)
        .then((url) => {
          created.failed = url === null
          return url
        })
      this.entries.set(id, created)
      entry = created
    }
    const held = entry
    held.refs += 1
    held.used = ++this.clock
    let released = false
    return {
      url: held.url,
      release: () => {
        if (!released) {
          released = true
          held.refs -= 1
          held.used = ++this.clock
          this.trim()
        }
      }
    }
  }

  // How many URLs are held right now, for tests.
  get size(): number {
    return this.entries.size
  }

  private trim(): void {
    const idle = [...this.entries].filter(([, entry]) => entry.refs === 0).sort(([, a], [, b]) => a.used - b.used)
    // A failed load is not worth keeping: the next viewer should try again.
    const excess = idle.length - this.keep
    idle.forEach(([id, entry], index) => {
      if (index < excess || entry.failed) {
        this.entries.delete(id)
        void entry.url.then((url) => url && this.revoke(url))
      }
    })
  }
}
