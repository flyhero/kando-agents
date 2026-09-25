import { z } from 'zod'

// Images live in core's attachment store, named by the sha256 of their bytes; tasks and
// snapshots refer to them by that name only.
export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/
export const AttachmentId = z.string().regex(ATTACHMENT_ID_PATTERN)

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
// Transfers go in pieces this size, so no frame comes near the socket's payload limit and
// terminal output keeps flowing while an image moves.
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024
const MAX_CHUNK_BASE64 = Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4
export const MAX_TASK_IMAGES = 20
export const MAX_IMAGE_NAME_LENGTH = 120

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export const Base64Chunk = z
  .string()
  .max(MAX_CHUNK_BASE64)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)

export const AttachmentInfo = z.object({
  id: AttachmentId,
  mime: z.enum(IMAGE_MIME_TYPES),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})
export type AttachmentInfo = z.infer<typeof AttachmentInfo>

// An image on a task, numbered by its place in the list: "图 1" is the first.
export const TaskImage = z.object({
  id: AttachmentId,
  name: z.string().max(MAX_IMAGE_NAME_LENGTH),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})
export type TaskImage = z.infer<typeof TaskImage>

export const ImageRef = z.object({ id: AttachmentId, name: z.string().trim().max(MAX_IMAGE_NAME_LENGTH) })

export function imageLabel(image: Pick<TaskImage, 'name'>, index: number): string {
  return image.name ? `图 ${index + 1} ${image.name}` : `图 ${index + 1}`
}
