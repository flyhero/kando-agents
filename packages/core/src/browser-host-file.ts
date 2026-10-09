import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { BrowserHostEndpoint, readJsonIfExists, type BrowserHostEndpoint as Endpoint } from '@kando/protocol/node'

// The app looks again this often for a host file a watcher missed (a home on a network mount).
const POLL_MS = 2_000

// Where the desktop app's browser host listens, as the app wrote it; null with no app running.
// A file that does not parse is treated as none: an app of another version wrote it.
export async function readBrowserHostEndpoint(file: string): Promise<Endpoint | null> {
  const parsed = BrowserHostEndpoint.safeParse(await readJsonIfExists(file).catch(() => undefined))
  return parsed.success ? parsed.data : null
}

// Says when the host file may have changed: the app came up, or went. Coarse on purpose; the
// caller reads the file and decides.
export function watchBrowserHostFile(file: string, changed: () => void): () => void {
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
      if (!name || name === path.basename(file)) changed()
    })
    watcher.on('error', () => {})
  } catch {
    // The directory is not there yet, or cannot be watched: polling covers it.
  }
  const poll = setInterval(changed, POLL_MS)
  poll.unref()
  return () => {
    watcher?.close()
    clearInterval(poll)
  }
}
