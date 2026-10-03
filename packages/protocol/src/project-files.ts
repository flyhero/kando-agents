import { z } from 'zod'

export const MAX_FILE_MATCHES = 50

// A file or folder in one of a conversation's projects, as the composer's @ menu offers it.
export const ProjectFileMatch = z.object({
  // Absolute.
  path: z.string(),
  // The project folder it was found under, and its path inside it.
  root: z.string(),
  relative: z.string(),
  kind: z.enum(['file', 'directory'])
})
export type ProjectFileMatch = z.infer<typeof ProjectFileMatch>
