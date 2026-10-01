import { setSettingsOpen, setWorktreesOpen, toggleBrowserPanel, toggleTerminalPanel, useBrowserSupported, useCore, useWorktreesSupported, type ConnectionState } from '../core-store'
import { ALL_TABS, useBrowserTabs } from '../browser-state'
import { formatBytes, worktreeRows, worktreeSummary } from '../worktree-groups'
import { useWorktrees } from '../worktree-store'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { BranchIcon, GearIcon, GlobeIcon, TerminalIcon } from './icons'
import { UsageBar } from './UsageBar'

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  'waiting-for-core': '等待 core 启动'
}

const CONNECTION_HINT: Record<ConnectionState, string> = {
  connected: '已连接到 Kando core',
  connecting: '正在连接 Kando core，断开后会自动重连',
  'waiting-for-core': '没有找到正在运行的 Kando core，先启动 pnpm dev:core'
}

// Healthy is the common case, so it shrinks to a dot; only trouble earns words.
function ConnectionStatus() {
  const connection = useCore((s) => s.connection)
  return (
    <span
      className="connection"
      data-state={connection}
      role="status"
      title={CONNECTION_HINT[connection]}
      aria-label={CONNECTION_HINT[connection]}
    >
      <span className="connection-dot" aria-hidden="true" />
      {connection !== 'connected' && <span>{CONNECTION_LABEL[connection]}</span>}
    </span>
  )
}

function SettingsButton() {
  const open = useCore((s) => s.settingsOpen)
  return (
    <button
      type="button"
      className="tool-button statusbar-settings"
      aria-label="设置"
      aria-pressed={open}
      data-tooltip={`设置 ${PRIMARY_KEY_LABEL},`}
      data-tooltip-side="top"
      onClick={() => setSettingsOpen(!open)}
    >
      <GearIcon />
    </button>
  )
}

// The browser panel, on a core that hosts one; the count is of the tabs known while it is open.
function BrowserButton() {
  const supported = useBrowserSupported()
  const open = useCore((s) => s.browserPanelOpen)
  const count = useBrowserTabs((s) => s[ALL_TABS]?.tabs.length ?? 0)
  if (!supported) return null
  return (
    <button
      type="button"
      className="tool-button statusbar-browser"
      aria-label="浏览器"
      aria-pressed={open}
      data-tooltip={open ? '隐藏浏览器 Ctrl+Shift+`' : '浏览器 Ctrl+Shift+`'}
      data-tooltip-side="top-end"
      onClick={toggleBrowserPanel}
    >
      <GlobeIcon />
      {open && count > 0 && <span className="count">{count}</span>}
    </button>
  )
}

function TerminalButton() {
  const open = useCore((s) => s.terminalPanelOpen)
  const count = useCore((s) => s.terminals.length)
  return (
    <button
      type="button"
      className="tool-button statusbar-terminal"
      aria-label="终端"
      aria-pressed={open}
      data-tooltip={open ? '隐藏终端 Ctrl+`' : '终端 Ctrl+`'}
      data-tooltip-side="top-end"
      onClick={() => void toggleTerminalPanel()}
    >
      <TerminalIcon />
      {count > 0 && <span className="count">{count}</span>}
    </button>
  )
}

// How many worktrees Kando has laid out and what they take, and how many could go: they are never
// removed of Kando's own accord, so this is where the user sees them pile up.
function WorktreeButton() {
  const supported = useWorktreesSupported()
  const list = useWorktrees((s) => s.list)
  const tasks = useCore((s) => s.tasks)
  const open = useCore((s) => s.worktreesOpen)
  if (!supported || !list || list.length === 0) return null
  const { count, bytes, cleanable } = worktreeSummary(worktreeRows(list, tasks))
  return (
    <button
      type="button"
      className="tool-button statusbar-worktrees"
      aria-pressed={open}
      data-tooltip="管理 Kando 建的 worktree"
      data-tooltip-side="top-end"
      onClick={() => setWorktreesOpen(!open)}
    >
      <BranchIcon />
      <span>{count} 个 worktree{bytes > 0 ? ` · ${formatBytes(bytes)}` : ''}</span>
      {cleanable > 0 && <span className="statusbar-worktrees-cleanable">· {cleanable} 个可清理</span>}
    </button>
  )
}

export function StatusBar() {
  return (
    <footer className="statusbar">
      <SettingsButton />
      <ConnectionStatus />
      <UsageBar />
      <WorktreeButton />
      <BrowserButton />
      <TerminalButton />
    </footer>
  )
}
