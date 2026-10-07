import { useId, useState } from 'react'
import { AGENT_KINDS, type AgentKind, type DetectedAgent, type EnvironmentCheck } from '@kando/protocol'
import { refreshEnvironment, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { setPreference, usePreferences } from '../preferences'
import { AgentIcon, RefreshIcon } from './icons'
import { Toggle } from './SettingsControls'

// Turning one off takes it out of every choice of agent for new work; the last one on stays on.
function setEnabled(kind: AgentKind, enabled: boolean): void {
  const { disabledAgents, defaultAgent } = usePreferences.getState()
  setPreference('disabledAgents', enabled ? disabledAgents.filter((each) => each !== kind) : [...new Set([...disabledAgents, kind])])
  // A default that can no longer be picked goes back to following the latest task.
  if (!enabled && defaultAgent === kind) setPreference('defaultAgent', 'recent')
}

function AgentRow({ kind, check, enabled, last }: { kind: AgentKind; check: EnvironmentCheck; enabled: boolean; last: boolean }) {
  const labelId = useId()
  const where = [check.version, check.path].filter(Boolean).join(' · ')
  return (
    <div className="settings-row agent-row" data-off={!enabled || undefined}>
      <span className="agent-row-icon" aria-hidden="true"><AgentIcon agent={kind} /></span>
      <div className="settings-row-text">
        <div className="agent-row-head">
          <span id={labelId} className="settings-row-label">{AGENT_LABEL[kind]}</span>
          {!enabled && <span className="agent-row-pill">已禁用</span>}
          {check.signedIn === false && <span className="environment-pill" data-level="warning">未登录</span>}
        </div>
        {where && <p className="settings-row-description mono agent-row-where" title={check.path ?? undefined}>{where}</p>}
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

// The agents core found on this machine, each on until the user turns it off. Off, an agent is
// not offered for new tasks and conversations; what already runs on it carries on.
export function InstalledAgentsSettings() {
  const environment = useCore((s) => s.environment)
  const disabled = usePreferences((s) => s.disabledAgents)
  const [checking, setChecking] = useState(false)
  const found = environment
    ? AGENT_KINDS.flatMap((kind) => {
      const check = environment.checks.find((each) => each.tool === kind && each.status !== 'missing')
      return check ? [{ kind, check }] : []
    })
    : []
  const other = environment?.detectedAgents?.filter((agent) => agent.id !== 'claude' && agent.id !== 'codex') ?? []
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
        <span className="agent-list-title">已安装</span>
        <span className="agent-list-count">{environment ? `${found.length + other.length} 个已检测` : '还没有检测'}</span>
        <button type="button" className="button ghost agent-list-refresh" onClick={() => void recheck()} disabled={checking}>
          <RefreshIcon />
          {checking ? '检测中…' : '重新检测'}
        </button>
      </div>
      <p className="settings-row-description agent-list-note">已支持的智能体默认启用，可在下方关闭。其他已发现的智能体暂不能在 Kando 中运行；命令响应版本检测也不代表已登录或支持聊天。检测范围包括 PATH 中的已知命令和 macOS 应用目录。</p>
      {environment && found.length + other.length === 0 && (
        <p className="settings-row-description agent-list-note">没有找到已知的智能体，到「环境」里看看 Claude Code 和 Codex 怎么安装。</p>
      )}
      {found.map(({ kind, check }) => {
        const enabled = !disabled.includes(kind)
        return <AgentRow key={kind} kind={kind} check={check} enabled={enabled} last={enabledCount <= 1} />
      })}
      {other.map((agent) => <DetectedAgentRow key={agent.id} agent={agent} />)}
    </div>
  )
}
