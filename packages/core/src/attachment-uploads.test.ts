import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachmentStore } from './attachment-store'
import { AttachmentUploads } from './attachment-uploads'
import { fakeConnection } from './fake-connection'
import { pngBytes } from './image-fixtures'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('AttachmentUploads', () => {
  let dir: string
  let uploads: AttachmentUploads

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-uploads-'))
    uploads = new AttachmentUploads(new AttachmentStore(dir), 30)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('assembles chunks in order and stores the result on commit', async () => {
    const owner = fakeConnection()
    const image = pngBytes(8, 8)
    const id = uploads.begin(owner, image.byteLength)
    uploads.append(owner, id, 0, b64(image.subarray(0, 20)))
    expect(() => uploads.append(owner, id, 0, b64(image.subarray(20)))).toThrow(/expected offset 20/)
    uploads.append(owner, id, 20, b64(image.subarray(20)))
    expect(await uploads.commit(owner, id)).toMatchObject({ width: 8, height: 8, mime: 'image/png' })
    await expect(uploads.commit(owner, id)).rejects.toMatchObject({ reason: 'attachment-upload-not-found' })
  })

  it('keeps an upload to its own connection, and to what it declared', async () => {
    const owner = fakeConnection()
    const id = uploads.begin(owner, 10)
    expect(() => uploads.append(fakeConnection(), id, 0, b64(new Uint8Array(4)))).toThrow(/no such upload/)
    expect(() => uploads.append(owner, id, 0, b64(new Uint8Array(11)))).toThrow(/past the declared size/)
    uploads.append(owner, id, 0, b64(new Uint8Array(4)))
    await expect(uploads.commit(owner, id)).rejects.toMatchObject({ reason: 'attachment-incomplete' })
  })

  it('limits uploads per connection and drops them when it closes or goes quiet', async () => {
    const owner = fakeConnection()
    const ids = [uploads.begin(owner, 4), uploads.begin(owner, 4), uploads.begin(owner, 4)]
    expect(() => uploads.begin(owner, 4)).toThrow(/too many uploads/)
    owner.close()
    expect(() => uploads.append(owner, ids[0] ?? '', 0, b64(new Uint8Array(4)))).toThrow(/no such upload/)
    const quiet = uploads.begin(owner, 4)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(() => uploads.append(owner, quiet, 0, b64(new Uint8Array(4)))).toThrow(/no such upload/)
  })
})
