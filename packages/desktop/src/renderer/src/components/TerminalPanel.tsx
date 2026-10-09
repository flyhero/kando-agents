import { useEffect, useState } from 'react'
import type { Terminal } from '@kando/protocol'
import { addQuote } from '../chat-quotes'
import { closeTerminal, openTerminal, selectTerminal, setTerminalMaximized, toggleTerminalPanel, useCore, useTerminalCommandsSupported, type CoreState } from '../core-store'
import { AgentIcon, CloseIcon, MaximizeIcon, PlusIcon, QuoteIcon, RestoreIcon } from './icons'
import { SessionTerminal } from './SessionTerminal'
import { TerminalCommandsButton } from './TerminalCommandsMenu'
import { terminalSelection } from './terminal-surface'

// Where a passage of the terminal goes: the conversation whose agent runs it, else the chat the
// user has open, a task's included.
function quoteTarget(state: CoreState, terminal: Terminal | undefined): string | null {
  if (terminal?.conversationId) return terminal.conversationId
  if (state.selectedConversationId) return state.selectedConversationId
  return state.selectedId ? state.tasks[state.selectedId]?.conversationId ?? null : null
}

// What the terminal shows, as text to quote: the spaces it pads each row with dropped.
function selectedLines(sessionId: string): string {
  return terminalSelection(sessionId).split('\n').map((line) => line.trimEnd()).join('\n').trim()
}

// Quotes what is selected in the terminal into a chat's input, to ask the agent about it.
function QuoteToChatButton({ terminal }: { terminal: Terminal | undefined }) {
  const target = useCore((s) => quoteTarget(s, terminal))
  const title = useCore((s) => (target ? s.conversations[target]?.title ?? null : null))
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), 2000)
    return () => clearTimeout(timer)
  }, [note])
  const quote = () => {
    if (!terminal || !target) return
    const text = selectedLines(terminal.sessionId)
    if (!text) return setNote('先在终端里选中要引用的内容')
    addQuote(target, null, text)
    setNote(title ? `已引用到「${title}」的输入框` : '已引用到输入框')
  }
  return (
    <>
      {note && <span className="terminal-quote-note" role="status">{note}</span>}
      <button
        type="button"
        className="tool-button"
        aria-label="引用到对话"
        data-tooltip={target ? '把选中的内容引用到对话的输入框' : '先打开一个会话，再引用'}
        disabled={!terminal || !target}
        // Keeps the terminal's selection and focus while the click reads it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={quote}
      >
        <QuoteIcon />
      </button>
    </>
  )
}

// Finite commands show how they ended; agent terminals also show whose they are.
function TabLabel({ terminal }: { terminal: Terminal }) {
  const owner = useCore((s) => (terminal.conversationId ? s.conversations[terminal.conversationId] : undefined))
  if (!terminal.command) return <>{terminal.title}</>
  const failed = terminal.exited && terminal.exitCode !== 0
  return (
    <>
      {terminal.conversationId && <span className="terminal-tab-agent" aria-hidden="true"><AgentIcon agent={owner?.agent ?? null} /></span>}
      {/* Before the command, which a narrow tab cuts short. */}
      {terminal.exited && <span className="terminal-tab-exit" data-failed={failed || undefined}>{failed ? terminal.exitCode ?? '已结束' : '✓'}</span>}
      {terminal.title}
    </>
  )
}

function tabTitle(terminal: Terminal, owner: string | null): string {
  if (!terminal.command) return terminal.cwd
  const ended = terminal.exited ? `\n已结束${terminal.exitCode === null || terminal.exitCode === undefined ? '' : `，退出码 ${terminal.exitCode}`}` : ''
  return `${terminal.conversationId ? `${owner ?? '会话'} 的 Agent 运行：` : ''}${terminal.command}\n${terminal.cwd}${ended}`
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
        <QuoteToChatButton terminal={active} />
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
