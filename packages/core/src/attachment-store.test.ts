import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentStore } from './attachment-store'
import { pngBytes } from './image-fixtures'

describe('AttachmentStore', () => {
  let dir: string
  let store: AttachmentStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-attachments-'))
    store = new AttachmentStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores an image once under the hash of its bytes, owner-only', async () => {
    const [first, second] = await Promise.all([store.put(pngBytes(4, 3)), store.put(pngBytes(4, 3))])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ mime: 'image/png', width: 4, height: 3 })
    expect(first?.id).toMatch(/^[0-9a-f]{64}\.png$/)
    const file = path.join(dir, first?.id ?? '')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(await new AttachmentStore(dir).info(first?.id ?? '')).toEqual(first)
    const bytes = await store.read(first?.id ?? '', 0, 8)
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('names by the stripped bytes, so metadata does not make a second copy', async () => {
    const plain = await store.put(pngBytes(4, 3))
    const tagged = await store.put(pngBytes(4, 3, [{ type: 'tEXt', data: 'where=home' }]))
    expect(tagged.id).toBe(plain.id)
  })

  it('refuses anything that is not a stored image by its exact name', async () => {
    await expect(store.put(Buffer.from('<svg/>'))).rejects.toMatchObject({ reason: 'attachment-not-image' })
    await expect(store.put(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ reason: 'attachment-too-large' })
    for (const id of ['../kando.db', `${'A'.repeat(64)}.png`, `${'a'.repeat(64)}.png\u0000`, `${'a'.repeat(64)}.svg`]) {
      await expect(store.read(id, 0, 1)).rejects.toMatchObject({ reason: 'attachment-not-found' })
      await expect(store.info(id)).rejects.toMatchObject({ reason: 'attachment-not-found' })
    }
  })

  it('does not follow a symlink planted under an image name', async () => {
    const outside = path.join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    const id = `${'b'.repeat(64)}.png`
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, id))
    await expect(store.read(id, 0, 6)).rejects.toMatchObject({ reason: 'attachment-not-found' })
    expect(await store.pathOf(id)).toBeNull()
  })
})
