import { lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ATTACHMENT_CHUNK_BYTES, imageLabel, type AttachmentInfo, type RpcConnection, type SnapshotImagePath, type Task } from '@kando/protocol'

// Where a stored image sits on this machine; null once it is gone (or is not a plain file).
export function attachmentPath(dir: string, id: string): string | null {
  const file = path.join(dir, id)
  try {
    return lstatSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

export function taskImageLines(task: Task, dir: string): string[] {
  return task.images.map((image, index) => `- ${imageLabel(image, index)}：${attachmentPath(dir, image.id) ?? '（图片已丢失）'}`)
}

export function snapshotImagePaths(task: Task, dir: string): SnapshotImagePath[] {
  return (task.sourceSnapshot?.images ?? []).map((image) => ({ name: image.name, path: attachmentPath(dir, image.id) }))
}

// Sends a local image to core in chunks; core decides whether it is an image at all.
export async function uploadImageFile(rpc: RpcConnection, file: string): Promise<AttachmentInfo> {
  const bytes = await readFile(file)
  const { uploadId } = await rpc.call('attachments.begin', { size: bytes.byteLength })
  for (let offset = 0; offset < bytes.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
    const data = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES).toString('base64')
    await rpc.call('attachments.append', { uploadId, offset, data })
  }
  return rpc.call('attachments.commit', { uploadId })
}
