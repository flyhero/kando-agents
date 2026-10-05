import { openTerminal, showError, showTerminal, useCore } from './core-store'
import { runsAtOnce } from './code-commands'
import { terminalReady, typeIntoTerminal } from './components/terminal-surface'

// Where a conversation's code blocks run: its own shell tab, opened in its folder the first time,
// so a `cd` in one block holds for the next. Kept while the window stays open.
export type RunScope = { key: string; cwd: string }

const tabs = new Map<string, string>()

async function scopeTerminal(scope: RunScope) {
  const kept = tabs.get(scope.key)
  const existing = useCore.getState().terminals.find((terminal) => terminal.id === kept && !terminal.conversationId && !terminal.exited)
  if (existing) return existing
  const opened = await openTerminal(scope.cwd)
  if (opened) tabs.set(scope.key, opened.id)
  return opened
}

// Brings up the scope's tab and types the command in; one line runs at once, several wait for
// the user's Enter (paste, below, never runs).
export async function runInTerminal(scope: RunScope, command: string, run = runsAtOnce(command)): Promise<void> {
  const terminal = await scopeTerminal(scope)
  if (!terminal) return
  showTerminal(terminal.id)
  if (!(await terminalReady(terminal.sessionId)) || !typeIntoTerminal(terminal.sessionId, command, run && runsAtOnce(command))) {
    showError('终端还没准备好，稍后再试')
  }
}
