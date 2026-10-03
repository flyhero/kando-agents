import { CHAT_COMMAND_ARGUMENTS, type ChatCommand, type SavedChatCommand } from '@kando/protocol'
import { isInside } from './terminal-commands'

// A command the composer offers: the user's own, which it expands into the input, or the agent's,
// which goes to the agent as typed.
export type CommandEntry =
  | { source: 'kando'; name: string; description: string; argumentHint: string | null; command: SavedChatCommand }
  | { source: 'agent'; name: string; description: string; argumentHint: string | null }

export function kandoEntries(commands: readonly SavedChatCommand[], projectPaths: readonly string[]): CommandEntry[] {
  return commands
    .filter((command) => command.projectPath === null || projectPaths.some((project) => isInside(project, command.projectPath ?? '')))
    .map((command) => ({
      source: 'kando',
      name: command.name,
      description: command.description || command.prompt.split('\n')[0] || '',
      argumentHint: takesArguments(command) ? '参数' : null,
      command
    }))
}

export function agentEntries(commands: readonly ChatCommand[]): CommandEntry[] {
  return commands.map((command) => ({ source: 'agent', ...command }))
}

export function takesArguments(command: Pick<SavedChatCommand, 'prompt'>): boolean {
  return command.prompt.includes(CHAT_COMMAND_ARGUMENTS)
}

// What the menu filters by: the name being typed, while the input holds nothing else.
export function commandQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text)
  return match ? (match[1] ?? '') : null
}

// Names that start with the query first, then names with it inside, then descriptions with it;
// each source keeps its own order.
export function matchCommands(entries: readonly CommandEntry[], query: string): CommandEntry[] {
  const needle = query.toLowerCase()
  const rank = (entry: CommandEntry) => {
    const name = entry.name.toLowerCase()
    if (name.startsWith(needle)) return 0
    if (name.includes(needle)) return 1
    return needle && entry.description.toLowerCase().includes(needle) ? 2 : -1
  }
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((each) => each.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((each) => each.entry)
}

// A prompt with what followed the command's name in place of $ARGUMENTS, or after it when it has none.
export function expandPrompt(prompt: string, args: string): string {
  const typed = args.trim()
  if (prompt.includes(CHAT_COMMAND_ARGUMENTS)) return prompt.split(CHAT_COMMAND_ARGUMENTS).join(typed).trim()
  return typed ? `${prompt}\n\n${typed}` : prompt
}

// The user's own command a message names, with what follows it: `/name args`.
export function typedKandoCommand(text: string, entries: readonly CommandEntry[]): { command: SavedChatCommand; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const name = match[1]?.toLowerCase()
  const entry = entries.find((each) => each.source === 'kando' && each.name.toLowerCase() === name)
  return entry?.source === 'kando' ? { command: entry.command, args: match[2] ?? '' } : null
}
