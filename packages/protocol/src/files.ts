import { z } from 'zod'

export const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024

export const ResolvedFile = z.object({
  path: z.string(),
  root: z.string().nullable(),
  relative: z.string().nullable(),
  kind: z.enum(['file', 'directory'])
})
export type ResolvedFile = z.infer<typeof ResolvedFile>

export const FileRead = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['not-found', 'is-directory', 'binary', 'too-large', 'unreadable']) })
])
export type FileRead = z.infer<typeof FileRead>
