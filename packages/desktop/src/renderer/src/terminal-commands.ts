import type { Task, TerminalCommand } from '@kando/protocol'

export function commandTitle(command: Pick<TerminalCommand, 'label' | 'command'>): string {
  return command.label || command.command
}

// The folder itself or anything under it, with either separator.
export function isInside(folder: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, '')
  return folder === base || folder.startsWith(`${base}/`) || folder.startsWith(`${base}\\`)
}

// The project a terminal works in. A task's worktree counts as the project it was checked out
// from, so a command kept for a project is there in each of its tasks too.
export function terminalProject(cwd: string, tasks: readonly Pick<Task, 'repos'>[]): string {
  for (const task of tasks) {
    const repo = task.repos.find((each) => each.worktreePath && isInside(cwd, each.worktreePath))
    if (repo) return repo.path
  }
  return cwd
}

// What a terminal in `project` offers, its own commands first. A query keeps the ones it is in,
// those it names ahead of those it is only somewhere in the command of.
export function offeredCommands(commands: readonly TerminalCommand[], project: string, query: string): {
  project: TerminalCommand[]
  global: TerminalCommand[]
} {
  const needle = query.trim().toLowerCase()
  const rank = (command: TerminalCommand) =>
    !needle ? 0 : command.label.toLowerCase().includes(needle) ? 0 : command.command.toLowerCase().includes(needle) ? 1 : -1
  const pick = (list: TerminalCommand[]) =>
    list
      .map((command) => ({ command, rank: rank(command) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.command)
  return {
    project: pick(commands.filter((command) => command.projectPath !== null && isInside(project, command.projectPath))),
    global: pick(commands.filter((command) => command.projectPath === null))
  }
}

// Without bracketed paste a shell reads each pasted line as it comes, and a later line could end
// up in the first one's stdin; joined, they run as one list.
export function pastedCommand(command: string, bracketedPaste: boolean): string {
  if (bracketedPaste) return command
  return command
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
}
