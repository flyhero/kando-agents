import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ATTACHMENT_ID_PATTERN, MAX_ATTACHMENT_BYTES, type AttachmentInfo } from '@kando/protocol'
import { IMAGE_MIME, ImageError, inspectImage, type ImageFacts } from './image-file'
import { Rejection } from './rejection'

// Images by content: the file name is the sha256 of the (metadata-stripped) bytes, so the same
// picture is stored once however many tasks show it, and a name can never point outside the folder.
export class AttachmentStore {
  // Facts read from disk, keyed by id; files never change once written.
  private readonly infos = new Map<string, AttachmentInfo>()

  constructor(private readonly dir: string) {}

  async put(input: Uint8Array): Promise<AttachmentInfo> {
    if (input.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Rejection('attachment-too-large', `images are limited to ${MAX_ATTACHMENT_BYTES} bytes`)
    }
    let facts: ImageFacts
    try {
      facts = inspectImage(input)
    } catch (error) {
      if (error instanceof ImageError) {
        throw new Rejection(`attachment-${error.problem}`, error.message)
      }
      throw error
    }
    const id = `${createHash('sha256').update(facts.bytes).digest('hex')}.${facts.format}`
    const info: AttachmentInfo = { id, mime: IMAGE_MIME[facts.format], size: facts.bytes.byteLength, width: facts.width, height: facts.height }
    const file = this.file(id)
    if (!(await this.isFile(file))) {
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await writeFile(tmp, facts.bytes, { mode: 0o600 })
        await chmod(tmp, 0o600)
        // Two writers of the same bytes race harmlessly: both renames leave identical content.
        await rename(tmp, file)
      } catch (error) {
        await rm(tmp, { force: true })
        throw error
      }
    }
    this.infos.set(id, info)
    return info
  }

  async info(id: string): Promise<AttachmentInfo | null> {
    const cached = this.infos.get(id)
    if (cached) {
      return cached
    }
    const file = this.file(id)
    if (!(await this.isFile(file))) {
      return null
    }
    try {
      const facts = inspectImage(await readFile(file))
      const info: AttachmentInfo = { id, mime: IMAGE_MIME[facts.format], size: facts.bytes.byteLength, width: facts.width, height: facts.height }
      this.infos.set(id, info)
      return info
    } catch {
      // Something other than an image the store wrote sits under that name: treat it as missing.
      return null
    }
  }

  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const file = this.file(id)
    if (!(await this.isFile(file))) {
      throw new Rejection('attachment-not-found', `no image ${id}`)
    }
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  // Absolute path for handing to an agent, or null when the image is gone.
  async pathOf(id: string): Promise<string | null> {
    const file = this.file(id)
    return (await this.isFile(file)) ? file : null
  }

  private file(id: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(id)) {
      throw new Rejection('attachment-not-found', `not an image id: ${id}`)
    }
    return path.join(this.dir, id)
  }

  // lstat, so a symlink planted under an image's name is not followed anywhere.
  private async isFile(file: string): Promise<boolean> {
    try {
      return (await lstat(file)).isFile()
    } catch {
      return false
    }
  }
}
