import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'

// Owner-only and all-or-nothing: a crash mid-write leaves the old file, never half of the new one.
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    // writeFile's mode is masked by umask; chmod is not.
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

// undefined when the file does not exist; a file that is there but unreadable is an error.
export async function readJsonIfExists(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  return JSON.parse(text)
}
