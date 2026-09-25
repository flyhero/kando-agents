import { setSettingsOpen, useCore, type ConnectionState } from '../core-store'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { GearIcon } from './icons'
import { UsageBar } from './UsageBar'

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  'waiting-for-core': '等待 core 启动'
}

const CONNECTION_HINT: Record<ConnectionState, string> = {
  connected: '已连接到 Ripen core',
  connecting: '正在连接 Ripen core，断开后会自动重连',
  'waiting-for-core': '没有找到正在运行的 Ripen core，先启动 pnpm dev:core'
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

export function StatusBar() {
  return (
    <footer className="statusbar">
      <SettingsButton />
      <ConnectionStatus />
      <UsageBar />
    </footer>
  )
}
