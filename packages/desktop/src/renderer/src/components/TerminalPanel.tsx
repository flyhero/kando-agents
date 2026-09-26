import { useState } from 'react'
import { closeTerminal, openTerminal, selectTerminal, setTerminalMaximized, toggleTerminalPanel, useCore } from '../core-store'
import { CloseIcon, MaximizeIcon, PlusIcon, RestoreIcon } from './icons'
import { PanelSeparator } from './PanelSeparator'
import { SessionTerminal } from './SessionTerminal'

const DEFAULT_TERMINAL_RATIO = 0.38

// The app's own terminals, beside everything else. Hiding the panel leaves the shells running in
// the daemon; closing a tab ends its shell.
export function TerminalPanel() {
  const terminals = useCore((s) => s.terminals)
  const activeId = useCore((s) => s.activeTerminalId)
  const maximized = useCore((s) => s.terminalMaximized)
  const [ratio, setRatio] = useState(DEFAULT_TERMINAL_RATIO)
  const active = terminals.find((terminal) => terminal.id === activeId) ?? terminals.at(-1)
  return (
    <>
      {!maximized && <PanelSeparator panelName="终端" ratio={ratio} onRatioChange={setRatio} />}
      <aside
        className="side-panel terminal-panel"
        aria-label="终端"
        data-maximized={maximized || undefined}
        style={maximized ? undefined : { flexBasis: `calc((100% - var(--side-panel-separator-size)) * ${ratio})` }}
      >
        <header className="terminal-panel-header">
          <div className="terminal-tabs" role="tablist" aria-label="终端">
            {terminals.map((terminal) => (
              <div key={terminal.id} className="terminal-tab" data-active={terminal.id === active?.id || undefined}>
                <button type="button" role="tab" aria-selected={terminal.id === active?.id} title={terminal.cwd} onClick={() => selectTerminal(terminal.id)}>
                  {terminal.title}
                </button>
                <button type="button" className="terminal-tab-close" aria-label={`关闭终端 ${terminal.title}`} title="关闭：结束这个终端" onClick={() => closeTerminal(terminal.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="tool-button" aria-label="新建终端" data-tooltip="新建终端" onClick={() => void openTerminal()}>
            <PlusIcon />
          </button>
          <button
            type="button"
            className="tool-button"
            aria-label={maximized ? '还原' : '最大化'}
            data-tooltip={maximized ? '还原' : '最大化'}
            onClick={() => setTerminalMaximized(!maximized)}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button type="button" className="tool-button" aria-label="隐藏终端" data-tooltip="隐藏（终端继续运行）" onClick={() => void toggleTerminalPanel()}>
            <CloseIcon />
          </button>
        </header>
        <div className="terminal-panel-body">
          {active ? (
            <SessionTerminal key={active.sessionId} sessionId={active.sessionId} />
          ) : (
            <p className="inspector-empty muted">正在打开终端…</p>
          )}
        </div>
      </aside>
    </>
  )
}
