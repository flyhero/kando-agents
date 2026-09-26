import { z } from 'zod'

// A shell the user opened in the app's own terminal panel, not tied to any task or conversation.
export const Terminal = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.number()
})
export type Terminal = z.infer<typeof Terminal>
