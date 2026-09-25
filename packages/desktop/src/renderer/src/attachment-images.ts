import { useEffect, useState } from 'react'
import { ATTACHMENT_CHUNK_BYTES, IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_NAME_LENGTH, type TaskImage } from '@kando/protocol'
import { base64ToBytes, bytesToBase64 } from './base64'
import { perform, useCore } from './core-store'
import { ImageCache } from './image-cache'

// Images come from core in chunks and are shown through object URLs; nothing loads from the web.
async function loadImage(id: string): Promise<string | null> {
  const { rpc } = useCore.getState()
  if (!rpc) {
    return null
  }
  const info = await rpc.call('attachments.stat', { id })
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let offset = 0; offset < info.size; offset += ATTACHMENT_CHUNK_BYTES) {
    const length = Math.min(ATTACHMENT_CHUNK_BYTES, info.size - offset)
    parts.push(base64ToBytes((await rpc.call('attachments.read', { id, offset, length })).data))
  }
  return URL.createObjectURL(new Blob(parts, { type: info.mime }))
}

const cache = new ImageCache(loadImage, (url) => URL.revokeObjectURL(url))

export function useImageUrl(id: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const handle = cache.acquire(id)
    let live = true
    void handle.url.then((loaded) => {
      if (live) {
        setUrl(loaded)
      }
    })
    return () => {
      live = false
      handle.release()
    }
  }, [id])
  return url
}

// Only image files count; text or HTML on the clipboard alongside them is left alone.
export function imageFilesOf(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => IMAGE_MIME_TYPES.some((type) => type === file.type))
}

// A pasted screenshot is called "image.png"; the image's number says more than that.
function nameOf(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, '')
  return base === 'image' ? '' : base.slice(0, MAX_IMAGE_NAME_LENGTH)
}

export async function uploadImageFiles(files: readonly File[]): Promise<TaskImage[]> {
  const uploaded: TaskImage[] = []
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useCore.setState({ error: `「${file.name}」超过 10MB，没有添加` })
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const info = await perform(async (rpc) => {
      const { uploadId } = await rpc.call('attachments.begin', { size: bytes.byteLength })
      for (let offset = 0; offset < bytes.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
        const data = bytesToBase64(bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES))
        await rpc.call('attachments.append', { uploadId, offset, data })
      }
      return rpc.call('attachments.commit', { uploadId })
    })
    if (info) {
      uploaded.push({ id: info.id, name: nameOf(file), width: info.width, height: info.height })
    }
  }
  return uploaded
}
