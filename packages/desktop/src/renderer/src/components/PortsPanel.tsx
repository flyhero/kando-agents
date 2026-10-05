import { useEffect, useState } from 'react'
import type { ListeningPort } from '@kando/protocol'
import { setPortsMaximized, showTerminal, togglePortsPanel, useCore } from '../core-store'
import { openPort, portGroups, portKey, stopPort, usePorts } from '../port-state'
import { ChatPicker } from './ChatPicker'
import { AgentIcon, CloseIcon, GlobeIcon, MaximizeIcon, PortsIcon, RestoreIcon, TerminalIcon } from './icons'
import './ports-panel.css'

function PortRow({ port }: { port: ListeningPort }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const browserSupported = useCore((s) => s.rpc?.features.includes('browser') ?? false)
  const connected = useCore((s) => s.connection === 'connected')
  const processName = port.command.split(/[\\/]/).at(-1) ?? port.command
  const terminalExists = useCore((s) => s.terminals.some((each) => each.id === port.terminalId))
  const stop = async () => {
    setBusy(true)
    try { if (await stopPort(port)) setConfirm(false) } finally { setBusy(false) }
  }
  return (
    <div className="port-row">
      <div className="port-row-title"><span className="port-listening-dot" aria-hidden="true" /><span className="port-number">{port.port}</span><span>{port.label ?? processName}</span><span className="port-state">监听中</span></div>
      <div className="port-process" data-tooltip={port.command}>{port.address} · PID {port.pid} · {processName}</div>
      <div className="port-actions">
        {browserSupported && <button type="button" className="link-button" disabled={busy || !connected} onClick={() => void openPort(port)}><GlobeIcon />打开页面</button>}
        {port.terminalId && <button type="button" className="link-button" disabled={busy || !terminalExists} onClick={() => port.terminalId && showTerminal(port.terminalId)}><TerminalIcon />终端</button>}
        <button type="button" className="link-button port-stop" disabled={busy || !connected || !port.canStop} data-tooltip={!port.canStop ? '这是 agent 的进程，不能从端口面板停止' : undefined} onClick={() => setConfirm(!confirm)}>{busy ? '正在停止…' : '停止'}</button>
      </div>
      {confirm && <div className="port-confirm" role="group" aria-label={`停止端口 ${port.port} 的服务`}><span>停止 {port.label ?? '服务'} :{port.port}？</span><span className="muted">终端标签保留。</span><div><button type="button" className="button danger small" disabled={busy} onClick={() => void stop()}>停止服务</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div></div>}
    </div>
  )
}

export function PortsPanel() {
  const { list, loading } = usePorts()
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const terminals = useCore((s) => s.terminals)
  const section = useCore((s) => s.section)
  const selectedTask = useCore((s) => s.selectedId)
  const selectedConversation = useCore((s) => s.selectedConversationId)
  const maximized = useCore((s) => s.portsMaximized)
  const [scope, setScope] = useState('all')
  const current = section === 'tasks' ? selectedTask : selectedConversation
  useEffect(() => { if (!current) setScope('all') }, [current])
  const ports = list.ports.filter((port) => scope === 'all' || (section === 'tasks' ? port.taskId === selectedTask : port.conversationId === selectedConversation))
  const groups = portGroups(ports, tasks, conversations, terminals)
  return (
    <aside className="side-panel ports-panel" aria-label="端口" data-maximized={maximized || undefined}>
      <header className="terminal-panel-header ports-panel-header"><h2 className="port-panel-title"><PortsIcon />端口 <span className="count">{list.ports.length}</span></h2><button type="button" className="tool-button" aria-label={maximized ? '还原' : '最大化'} data-tooltip={maximized ? '还原' : '最大化'} onClick={() => setPortsMaximized(!maximized)}>{maximized ? <RestoreIcon /> : <MaximizeIcon />}</button><button type="button" className="tool-button" aria-label="隐藏端口" data-tooltip="隐藏端口" onClick={togglePortsPanel}><CloseIcon /></button></header>
      <div className="ports-panel-body"><div className="ports-toolbar"><ChatPicker label="端口范围" placement="below" value={scope} placeholder="全部任务与会话" onChange={setScope} options={[{ value: 'all', label: '全部任务与会话' }, { value: 'current', label: section === 'tasks' ? '当前任务' : '当前会话', disabled: !current }]} /><span className="muted">{loading ? '正在发现…' : '每 2 秒更新'}</span></div>
        {list.problem ? <p className="port-problem" role="alert">{list.problem}</p> : groups.length === 0 ? <p className="inspector-empty muted">{loading ? '正在查找监听端口…' : '没有发现监听端口。可在 Kando 终端中启动开发服务。'}</p> : groups.map((group) => <section key={group.id} className="port-group"><div className="port-group-title"><span>{group.title}</span>{group.conversation && <span className="port-owner"><AgentIcon agent={group.conversation.agent} />{group.conversation.agent === 'claude' ? 'Claude Code' : 'Codex'}</span>}</div>{group.ports.map((port) => <PortRow key={portKey(port)} port={port} />)}</section>)}
      </div><footer className="ports-panel-footer">{ports.length} 个监听端口 · {groups.length} 个分组</footer>
    </aside>
  )
}
