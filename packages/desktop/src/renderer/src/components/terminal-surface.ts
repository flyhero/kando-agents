import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { RpcConnection } from '@kando/protocol'
import { onThemeChange } from '../appearance'
import { usePreferences } from '../preferences'
import { terminalTheme } from './terminal-theme'

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
      term.dispose()
    }
  }
}
