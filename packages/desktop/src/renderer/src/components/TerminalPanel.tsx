import type { Terminal } from '@kando/protocol'
import { closeTerminal, openTerminal, selectTerminal, setTerminalMaximized, toggleTerminalPanel, useCore, useTerminalCommandsSupported } from '../core-store'
import { AgentIcon, CloseIcon, MaximizeIcon, PlusIcon, RestoreIcon } from './icons'
import { SessionTerminal } from './SessionTerminal'
import { TerminalCommandsButton } from './TerminalCommandsMenu'

// An agent's terminal says whose it is and how its command ended.
function TabLabel({ terminal }: { terminal: Terminal }) {
  const owner = useCore((s) => (terminal.conversationId ? s.conversations[terminal.conversationId] : undefined))
  if (!terminal.conversationId) return <>{terminal.title}</>
  const failed = terminal.exited && terminal.exitCode !== 0
  return (
    <>
      <span className="terminal-tab-agent" aria-hidden="true"><AgentIcon agent={owner?.agent ?? null} /></span>
      {/* Before the command, which a narrow tab cuts short. */}
      {terminal.exited && <span className="terminal-tab-exit" data-failed={failed || undefined}>{failed ? terminal.exitCode ?? '已结束' : '✓'}</span>}
      {terminal.title}
    </>
  )
}

function tabTitle(terminal: Terminal, owner: string | null): string {
  if (!terminal.conversationId) return terminal.cwd
  const ended = terminal.exited ? `\n已结束${terminal.exitCode === null || terminal.exitCode === undefined ? '' : `，退出码 ${terminal.exitCode}`}` : ''
  return `${owner ?? '会话'} 的 agent 运行：${terminal.command ?? terminal.title}\n${terminal.cwd}${ended}`
}

// The app's own terminals: the user's shells, and commands agents run where the user can watch.
// The dock puts them below the browser when both are open. Hiding the panel leaves them running in
// the daemon; closing a tab ends what runs in it.
export function TerminalPanel() {
  const terminals = useCore((s) => s.terminals)
  const activeId = useCore((s) => s.activeTerminalId)
  const maximized = useCore((s) => s.terminalMaximized)
  const commandsSupported = useTerminalCommandsSupported()
  const conversations = useCore((s) => s.conversations)
  const active = terminals.find((terminal) => terminal.id === activeId) ?? terminals.at(-1)
  return (
    <aside className="side-panel terminal-panel" aria-label="终端" data-maximized={maximized || undefined}>
      <header className="terminal-panel-header">
        <div className="terminal-tab-strip">
          <div className="terminal-tabs" role="tablist" aria-label="终端">
            {terminals.map((terminal) => (
              <div key={terminal.id} className="terminal-tab" data-active={terminal.id === active?.id || undefined} data-agent={terminal.conversationId ? true : undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={terminal.id === active?.id}
                  title={tabTitle(terminal, terminal.conversationId ? conversations[terminal.conversationId]?.title ?? null : null)}
                  onClick={() => selectTerminal(terminal.id)}
                >
                  <TabLabel terminal={terminal} />
                </button>
                <button type="button" className="terminal-tab-close" aria-label={`关闭终端 ${terminal.title}`} title="关闭：结束这个终端" onClick={() => closeTerminal(terminal.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="tool-button terminal-tab-add" aria-label="新建终端" data-tooltip="新建终端" onClick={() => void openTerminal()}>
            <PlusIcon />
          </button>
        </div>
        {commandsSupported && <TerminalCommandsButton terminal={active} />}
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
  )
}
