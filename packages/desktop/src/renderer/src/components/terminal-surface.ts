import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { RpcConnection } from '@kando/protocol'
import { onThemeChange } from '../appearance'
import { usePreferences } from '../preferences'
import { pastedCommand } from '../terminal-commands'
import { terminalTheme } from './terminal-theme'

// Each session's terminal on screen, so a control outside it can type into it or read what is selected.
const shown = new Map<string, Terminal>()

// Typed as a paste would be, so a shell with bracketed paste takes every line at its prompt
// before Enter runs them.
export function typeIntoTerminal(sessionId: string, command: string, run: boolean): boolean {
  const term = shown.get(sessionId)
  if (!term) return false
  term.paste(pastedCommand(command, term.modes.bracketedPasteMode))
  if (run) term.input('\r')
  term.focus()
  return true
}

// Resolves once the session's terminal is on screen and its shell has printed something, its prompt
// most likely, so what is typed next lands at that prompt; false if neither comes in time.
export async function terminalReady(sessionId: string, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const term = shown.get(sessionId)
    const buffer = term?.buffer.active
    if (buffer && (buffer.length > 1 || buffer.cursorX > 0)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return shown.has(sessionId)
}

export function terminalSelection(sessionId: string): string {
  return shown.get(sessionId)?.getSelection() ?? ''
}

export function createTerminalSurface(element: HTMLElement, rpc: RpcConnection, sessionId: string | null) {
  const term = new Terminal({
    fontSize: usePreferences.getState().terminalFontSize,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    cursorBlink: Boolean(sessionId), theme: terminalTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(element)
  fit.fit()
  if (sessionId) shown.set(sessionId, term)
  const sendSize = () => {
    if (sessionId) void rpc.call('sessions.resize', { sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
  }
  const stopTheming = onThemeChange(() => { term.options.theme = terminalTheme() })
  const observer = new ResizeObserver(() => { fit.fit(); sendSize() })
  observer.observe(element)
  const stopFontSizing = usePreferences.subscribe((next, previous) => {
    if (next.terminalFontSize !== previous.terminalFontSize) {
      term.options.fontSize = next.terminalFontSize
      fit.fit()
      sendSize()
    }
  })
  return {
    term, sendSize,
    dispose: () => {
      stopTheming()
      stopFontSizing()
      observer.disconnect()
      if (sessionId && shown.get(sessionId) === term) shown.delete(sessionId)
      term.dispose()
    }
  }
}
