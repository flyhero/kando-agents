import { useState } from 'react'
import { setAwakeMode, setSchedulesOpen, setSettingsOpen, setWorktreesOpen, toggleBrowserPanel, togglePortsPanel, toggleTerminalPanel, useAwakeSupported, useBrowserSupported, useCore, useSchedulesSupported, useWorktreesSupported, type ConnectionState } from '../core-store'
import { ALL_TABS, useBrowserTabs } from '../browser-state'
import { formatBytes, worktreeRows, worktreeSummary } from '../worktree-groups'
import { useWorktrees } from '../worktree-store'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { BranchIcon, CheckIcon, ClockIcon, CoffeeIcon, GearIcon, GlobeIcon, PortsIcon, TerminalIcon } from './icons'
import { usePorts } from '../port-state'
import { UsageBar } from './UsageBar'
import { openRuns } from '../schedules'
import { Popover } from './Popover'

type ConnectionIssue = Exclude<ConnectionState, 'connected'>

const CONNECTION_LABEL: Record<ConnectionIssue, string> = {
  connecting: '连接中…',
  'waiting-for-core': '等待 core 启动'
}

const CONNECTION_HINT: Record<ConnectionIssue, string> = {
  connecting: '正在连接 Kando core，断开后会自动重连',
  'waiting-for-core': '没有找到正在运行的 Kando core，先启动 pnpm dev:core'
}

// Only interruptions need a status-bar indicator; healthy is the default.
function ConnectionStatus() {
  const connection = useCore((s) => s.connection)
  if (connection === 'connected') return null
  return (
    <span
      className="connection"
      data-state={connection}
      role="status"
      title={CONNECTION_HINT[connection]}
      aria-label={CONNECTION_HINT[connection]}
    >
      <span className="connection-dot" aria-hidden="true" />
      <span>{CONNECTION_LABEL[connection]}</span>
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

// The browser panel, on a core that hosts one; keep the latest known tab count visible while the
// panel is closed, as terminals do.
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
      {count > 0 && <span className="count">{count}</span>}
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

function PortsButton() {
  const supported = useCore((s) => s.rpc?.features.includes('ports') ?? false)
  const open = useCore((s) => s.portsPanelOpen)
  const count = usePorts((s) => s.list.ports.length)
  if (!supported) return null
  return <button type="button" className="tool-button statusbar-ports" aria-label="端口" aria-pressed={open} data-tooltip={open ? '隐藏端口' : '管理开发服务端口'} data-tooltip-side="top-end" onClick={togglePortsPanel}><PortsIcon />{count > 0 && <span className="count">{count}</span>}</button>
}

const AWAKE_LABEL = { on: '始终', auto: 'Agent 工作或有预约时', off: '关闭' } as const

function AwakeButton() {
  const supported = useAwakeSupported()
  const status = useCore((s) => s.awake)
  const [open, setOpen] = useState(false)
  if (!supported || !status) return null
  const reasons = [
    status.workingAgents > 0 && `${status.workingAgents} 个 Agent 工作中`,
    (status.scheduledRuns ?? 0) > 0 && `${status.scheduledRuns} 个预约等着运行`
  ].filter(Boolean).join('，')
  const detail = status.problem ?? (status.active ? `正在保持唤醒${reasons ? ` · ${reasons}` : ''}` : `保持唤醒：${AWAKE_LABEL[status.mode]}`)
  return (
    <span className="menu-anchor statusbar-awake-anchor">
      <button
        type="button"
        className="tool-button statusbar-awake"
        aria-label={detail}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-active={status.active}
        data-tooltip={detail}
        data-tooltip-side="top-end"
        onClick={() => setOpen((value) => !value)}
      >
        <CoffeeIcon />
        {status.active && <span className="awake-dot" aria-hidden="true" />}
      </button>
      {open && (
        <Popover label="保持电脑唤醒" onClose={() => setOpen(false)}>
          <div className="menu-label">保持电脑唤醒</div>
          {(['on', 'auto', 'off'] as const).map((mode) => (
            <button key={mode} type="button" className="menu-item" onClick={() => { void setAwakeMode(mode); setOpen(false) }}>
              <span>{AWAKE_LABEL[mode]}</span>
              <span className="menu-check">{status.mode === mode && <CheckIcon />}</span>
            </button>
          ))}
          {status.problem && <div className="menu-note">{status.problem}</div>}
        </Popover>
      )}
    </span>
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

// What is scheduled to start later, and whether any of it failed: the way to the page that manages
// them. Shown while there is anything to show there.
function ScheduleButton() {
  const supported = useSchedulesSupported()
  // A routine's runs are the routine's, shown on its own page.
  const runs = useCore((s) => s.schedules).filter((run) => run.target.kind !== 'routine')
  const open = useCore((s) => s.schedulesOpen)
  if (!supported || (runs.length === 0 && !open)) return null
  const waiting = openRuns(runs).length
  const failed = runs.filter((run) => run.status === 'failed').length
  return (
    <button
      type="button"
      className="tool-button statusbar-schedules"
      aria-pressed={open}
      data-tooltip="管理预约的任务和会话"
      data-tooltip-side="top-end"
      onClick={() => setSchedulesOpen(!open)}
    >
      <ClockIcon />
      <span>{waiting > 0 ? `${waiting} 个预约` : '预约'}</span>
      {failed > 0 && <span className="statusbar-schedules-failed">· {failed} 个没能开始</span>}
    </button>
  )
}

export function StatusBar() {
  return (
    <footer className="statusbar">
      <SettingsButton />
      <ConnectionStatus />
      <UsageBar />
      <ScheduleButton />
      <WorktreeButton />
      <PortsButton />
      <BrowserButton />
      <TerminalButton />
      <AwakeButton />
    </footer>
  )
}
