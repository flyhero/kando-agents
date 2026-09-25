import { randomUUID } from 'node:crypto'
import { ATTACHMENT_CHUNK_BYTES, type AttachmentInfo } from '@kando/protocol'
import type { AttachmentStore } from './attachment-store'
import { Rejection } from './rejection'
import type { Connection } from './rpc-server'

export type UploadOwner = Pick<Connection, 'onClose'>

type Upload = { owner: UploadOwner; size: number; chunks: Buffer[]; received: number; timer: ReturnType<typeof setTimeout> }

const PER_CONNECTION = 3
const IDLE_MS = 2 * 60_000

// Images arrive in chunks and are held in memory until committed. An upload belongs to the
// connection that began it and is dropped when that connection goes away or goes quiet.
export class AttachmentUploads {
  private readonly uploads = new Map<string, Upload>()
  private readonly watched = new WeakSet<UploadOwner>()

  constructor(
    private readonly store: AttachmentStore,
    private readonly idleMs: number = IDLE_MS
  ) {}

  begin(owner: UploadOwner, size: number): string {
    const open = [...this.uploads.values()].filter((upload) => upload.owner === owner).length
    if (open >= PER_CONNECTION) {
      throw new Rejection('attachment-busy', 'too many uploads at once')
    }
    if (!this.watched.has(owner)) {
      this.watched.add(owner)
      owner.onClose(() => this.dropAll(owner))
    }
    const id = randomUUID()
    this.uploads.set(id, { owner, size, chunks: [], received: 0, timer: this.idleTimer(id) })
    return id
  }

  append(owner: UploadOwner, uploadId: string, offset: number, data: string): void {
    const upload = this.owned(owner, uploadId)
    const chunk = Buffer.from(data, 'base64')
    if (offset !== upload.received) {
      throw new Rejection('attachment-out-of-order', `expected offset ${upload.received}, got ${offset}`)
    }
    if (chunk.byteLength === 0 || chunk.byteLength > ATTACHMENT_CHUNK_BYTES || upload.received + chunk.byteLength > upload.size) {
      throw new Rejection('attachment-bad-chunk', 'chunk is empty, too large, or past the declared size')
    }
    upload.chunks.push(chunk)
    upload.received += chunk.byteLength
    clearTimeout(upload.timer)
    upload.timer = this.idleTimer(uploadId)
  }

  async commit(owner: UploadOwner, uploadId: string): Promise<AttachmentInfo> {
    const upload = this.owned(owner, uploadId)
    this.drop(uploadId)
    if (upload.received !== upload.size) {
      throw new Rejection('attachment-incomplete', `got ${upload.received} of ${upload.size} bytes`)
    }
    return this.store.put(Buffer.concat(upload.chunks))
  }

  private owned(owner: UploadOwner, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.owner !== owner) {
      throw new Rejection('attachment-upload-not-found', 'no such upload in progress')
    }
    return upload
  }

  private idleTimer(uploadId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.drop(uploadId), this.idleMs)
    timer.unref()
    return timer
  }

  private drop(uploadId: string): void {
    const upload = this.uploads.get(uploadId)
    if (upload) {
      clearTimeout(upload.timer)
      this.uploads.delete(uploadId)
    }
  }

  private dropAll(owner: UploadOwner): void {
    for (const [id, upload] of this.uploads) {
      if (upload.owner === owner) {
        this.drop(id)
      }
    }
  }
}
