import { lstatSync } from 'node:fs'
import path from 'node:path'

// Where a stored image sits on this machine; null once it is gone (or is not a plain file).
export function attachmentPath(dir: string, id: string): string | null {
  const file = path.join(dir, id)
  try {
    return lstatSync(file).isFile() ? file : null
  } catch {
    return null
  }
}
