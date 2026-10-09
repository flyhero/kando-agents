import { useId, useState, type ReactNode } from 'react'
import { AGENT_KINDS, type AgentKind, type DetectedAgent, type EnvironmentCheck } from '@kando/protocol'
import { refreshEnvironment, useCore } from '../core-store'
import { INSTALL_HINT, SIGN_IN_HINT, TOOL_ROLE } from '../environment-text'
import { AGENT_LABEL } from '../labels'
import { setPreference, usePreferences } from '../preferences'
import { CopyButton } from './CopyButton'
import { AgentIcon, RefreshIcon } from './icons'
import { Toggle } from './SettingsControls'

// Turning one off takes it out of every choice of agent for new work; the last one on stays on.
function setEnabled(kind: AgentKind, enabled: boolean): void {
  const { disabledAgents, defaultAgent } = usePreferences.getState()
  setPreference('disabledAgents', enabled ? disabledAgents.filter((each) => each !== kind) : [...new Set([...disabledAgents, kind])])
  // A default that can no longer be picked goes back to following the latest task.
  if (!enabled && defaultAgent === kind) setPreference('defaultAgent', 'recent')
}

// What to type to put it right, copyable: an install for one that is not there, a sign-in for one
// with no account.
function Fix({ label, command }: { label: string; command: string }) {
  return (
    <p className="environment-fix">
      <span>{label}</span>
      <code>{command}</code>
      <CopyButton text={command} label="复制命令" />
    </p>
  )
}

function AgentRow({ kind, check, enabled, last }: { kind: AgentKind; check: EnvironmentCheck; enabled: boolean; last: boolean }) {
  const labelId = useId()
  const version = check.version ?? (check.status === 'unknown' ? '版本未知' : null)
  return (
    <div className="settings-row agent-row" data-off={!enabled || undefined}>
      <span className="agent-row-icon" aria-hidden="true"><AgentIcon agent={kind} /></span>
      <div className="settings-row-text">
        <div className="agent-row-head">
          <span id={labelId} className="settings-row-label">{AGENT_LABEL[kind]}</span>
          {version && <span className="agent-row-version mono" title={check.path ?? undefined}>{version}</span>}
          {!enabled && <span className="agent-row-pill">已禁用</span>}
          {check.signedIn !== null && (
            <span className="environment-pill" data-level={check.signedIn ? 'ok' : 'warning'}>{check.signedIn ? '已登录' : '未登录'}</span>
          )}
        </div>
        {check.signedIn === false && <Fix label="登录：" command={SIGN_IN_HINT[kind]} />}
      </div>
      <div className="settings-row-control">
        <Toggle
          labelId={labelId}
          checked={enabled}
          disabled={enabled && last}
          title={enabled && last ? '至少保留一个启用的智能体' : undefined}
          onChange={(next) => setEnabled(kind, next)}
        />
      </div>
    </div>
  )
}

// One Kando can run but this machine does not have: dimmed, with what to type to install it.
function MissingAgentRow({ kind }: { kind: AgentKind }) {
  return (
    <div className="settings-row agent-row" data-off>
      <span className="agent-row-icon" aria-hidden="true"><AgentIcon agent={kind} /></span>
      <div className="settings-row-text">
        <div className="agent-row-head">
          <span className="settings-row-label">{AGENT_LABEL[kind]}</span>
          <span className="agent-row-pill">未安装</span>
        </div>
        <p className="settings-row-description">{TOOL_ROLE[kind]}</p>
        <Fix label="安装：" command={INSTALL_HINT[kind]} />
      </div>
    </div>
  )
}

function DetectedAgentRow({ agent }: { agent: DetectedAgent }) {
  const cli = agent.cliCheck
  let cliLabel = '仅发现应用 · 未找到 Agent 命令'
  if (cli?.status === 'responded') cliLabel = `命令已响应${cli.version ? ` · ${cli.version}` : ' · 版本未识别'}`
  else if (cli?.reason === 'windows-shim') cliLabel = '找到命令 · Windows 命令垫片无法直接验证版本'
  else if (cli?.reason === 'probe-failed') cliLabel = '找到命令 · 版本检测失败，可能无法启动'
  else if (agent.locations.some((location) => location.source === 'cli')) cliLabel = '找到命令 · 尚未验证版本'
  return (
    <div className="settings-row agent-row">
      <span className="agent-row-icon" aria-hidden="true"><AgentIcon agent={null} /></span>
      <div className="settings-row-text">
        <div className="agent-row-head">
          <span className="settings-row-label">{agent.name}</span>
          <span className="agent-row-pill">暂未支持</span>
        </div>
        <p className="settings-row-description">{cliLabel}</p>
        {agent.locations.map(({ source, path }) => (
          <p key={`${source}:${path}`} className="settings-row-description mono agent-row-where" title={path}>
            {source === 'cli' ? '命令' : '应用'} · {path}
          </p>
        ))}
      </div>
    </div>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null
  return (
    <div className="agent-group">
      <div className="agent-group-head">
        <span className="agent-group-title">{title}</span>
        <span className="agent-list-count">{count}</span>
      </div>
      {children}
    </div>
  )
}

// Every agent in one place, as core found them: the ones Kando runs, each on until turned off (off,
// it is not offered for new tasks and conversations; what already runs on it carries on); the
// ones it runs that are not installed, with how to install them; and others it found but cannot
// run yet. Git, which is not an agent, is under 关于.
export function InstalledAgentsSettings() {
  const environment = useCore((s) => s.environment)
  const disabled = usePreferences((s) => s.disabledAgents)
  const [checking, setChecking] = useState(false)
  const checkOf = (kind: AgentKind) => environment?.checks.find((each) => each.tool === kind)
  const found = AGENT_KINDS.flatMap((kind) => {
    const check = checkOf(kind)
    return check && check.status !== 'missing' ? [{ kind, check }] : []
  })
  const missing = AGENT_KINDS.filter((kind) => checkOf(kind)?.status === 'missing')
  const other = environment?.detectedAgents?.filter((agent) => !AGENT_KINDS.some((kind) => kind === agent.id)) ?? []
  const enabledCount = found.filter(({ kind }) => !disabled.includes(kind)).length
  const recheck = async () => {
    setChecking(true)
    try {
      await refreshEnvironment()
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="agent-list">
      <div className="agent-list-head">
        <span className="agent-list-title">这台电脑上的智能体</span>
        <button type="button" className="button ghost agent-list-refresh" onClick={() => void recheck()} disabled={checking} title="装好或登录后，重新查一遍">
          <RefreshIcon />
          {checking ? '检测中…' : '重新检测'}
        </button>
      </div>
      {!environment && <p className="settings-row-description agent-list-note">还没有检测。</p>}
      <Group title="已安装" count={found.length}>
        {found.map(({ kind, check }) => (
          <AgentRow key={kind} kind={kind} check={check} enabled={!disabled.includes(kind)} last={enabledCount <= 1} />
        ))}
      </Group>
      <Group title="可安装" count={missing.length}>
        {missing.map((kind) => <MissingAgentRow key={kind} kind={kind} />)}
      </Group>
      <Group title="暂未支持" count={other.length}>
        <p className="settings-row-description agent-list-note">在这台电脑上找到了，但还不能在 Kando 里运行；命令能响应版本，不代表已登录或支持聊天。</p>
        {other.map((agent) => <DetectedAgentRow key={agent.id} agent={agent} />)}
      </Group>
      {environment && (
        <details className="environment-search-path">
          <summary>Kando 在这些目录里找命令（{environment.searchPath.length} 个）</summary>
          <p className="settings-row-description">
            这是 core 启动时的 PATH，Agent 也用它启动；macOS 上还会看 /Applications 和 ~/Applications 里的应用。装在别处的，把它所在的目录加进登录 shell 的 PATH，再重启 Kando。
          </p>
          <ul className="mono">
            {environment.searchPath.map((dir) => (
              <li key={dir}>{dir}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
