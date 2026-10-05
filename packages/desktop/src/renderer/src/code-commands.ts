// A code block in a reply the user can run in the terminal: one fenced as a shell. A console block
// mixes commands with what they printed, so only its `$ ` lines are commands.
const SHELL_FENCES = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'shell-session'])

export function blockCommand(language: string | null, code: string): string | null {
  if (!language || !SHELL_FENCES.has(language.toLowerCase())) return null
  const text = code.replace(/\n+$/, '')
  if (['console', 'shell-session'].includes(language.toLowerCase())) {
    const prompted = text.split('\n').filter((line) => /^\$ /.test(line)).map((line) => line.slice(2))
    return prompted.length > 0 ? prompted.join('\n') : null
  }
  return text.trim() ? text : null
}

// More than one line is pasted, not run: the user looks it over and presses Enter.
export function runsAtOnce(command: string): boolean {
  return !command.includes('\n')
}
