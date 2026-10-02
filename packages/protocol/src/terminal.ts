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

export const MAX_TERMINAL_COMMANDS = 200

// A command the user keeps for the terminal panel, so they need not retype or remember it.
export const TerminalCommandFields = z.object({
  // Empty: the command names itself.
  label: z.string().trim().max(80),
  command: z.string().trim().min(1).max(4000),
  // Off, the command lands on the prompt for the user to finish before pressing Enter.
  run: z.boolean(),
  // Offered only in terminals inside this folder or one of its worktrees; null, in every terminal.
  projectPath: z.string().min(1).nullable()
})
export const TerminalCommand = TerminalCommandFields.extend({ id: z.string().uuid(), createdAt: z.number() })
export type TerminalCommand = z.infer<typeof TerminalCommand>
