import { z } from 'zod'
import { kandoToolName } from './chat'

// A terminal in the app's panel: a shell, an agent command, or a user-started CLI installer.
export const Terminal = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.number(),
  // A terminal an agent opened to run a command: the conversation it belongs to, the command, and
  // once the command ends, its exit code; it stays until the user closes it. User-started CLI
  // installers have a command without a conversation. Interactive shells have neither.
  conversationId: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  exited: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional()
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

// What an agent's terminal holds, as the agent reads it: the end of its output in plain text, and
// whether the command still runs.
export const TerminalOutput = z.object({
  id: z.string().uuid(),
  command: z.string(),
  output: z.string(),
  // The output was longer than what came back.
  truncated: z.boolean(),
  running: z.boolean(),
  exitCode: z.number().int().nullable()
})
export type TerminalOutput = z.infer<typeof TerminalOutput>

// How a run went: started in a terminal, or waiting on the user (Kando asks where the agent does
// not), or refused by them.
export const TerminalRun = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('started'), terminal: Terminal }),
  z.object({ outcome: z.literal('awaiting') }),
  z.object({ outcome: z.literal('denied') })
])
export type TerminalRun = z.infer<typeof TerminalRun>

// The tools that give an agent terminals of its own in the app's panel, by their MCP names.
export const TERMINAL_TOOLS = ['run', 'read', 'stop'] as const
export type TerminalToolKind = (typeof TERMINAL_TOOLS)[number]
export function terminalToolName(kind: TerminalToolKind): string {
  return `terminal_${kind}`
}
// Kando's own question, as an approval, before it runs an agent's command where the agent asks
// nothing for MCP tools (Codex).
export const TERMINAL_RUN_TOOL = 'kando_terminal_run'

// Which terminal tool a call is, by the name the agent knows it by (mcp__kando__terminal_run,
// kando.terminal_run), or null for any other.
export function terminalToolKind(name: string): TerminalToolKind | null {
  const own = kandoToolName(name)
  if (!own?.startsWith('terminal_')) return null
  return TERMINAL_TOOLS.find((kind) => kind === own.slice('terminal_'.length)) ?? null
}
