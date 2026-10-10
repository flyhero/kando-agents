import { useEffect, useRef, useState } from 'react'
import type { AgentKind, Conversation, Task } from '@kando/protocol'
import { dismissError, perform, setSettingsOpen, useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { AgentQuotaHint, confirmQuota } from './AgentQuota'
import { startOptions } from './ConversationActions'
import { useOccludesBrowser } from '../browser-occlusion'

// A task's chat goes through the task, whose agent the new one becomes; core takes it only from an
// idle agent, so there is nothing to stop.
export function ConversationHandoffDialog({ conversation, task, initial = null, blocker = null, onClose }: {
  conversation: Conversation
  task?: Task
  // The agent picked before the dialog opened, as from a task's agent picker.
  initial?: AgentKind | null
  // Why the task's chat cannot go now (see checkTaskHandoff).
  blocker?: string | null
  onClose: () => void
}) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // An idle agent has nothing to lose, so core lets it go without asking.
  const mustConfirm = !task && conversation.sessionId !== null && conversation.chat?.turn !== 'idle'
  const from = task?.agent ?? conversation.agent
  const error = useCore((s) => s.error)
  // Another agent that is installed here; none, and there is nowhere to hand off to.
  const targets = useInstalledAgents().filter((agent) => agent !== from)
  const [selected, setSelected] = useState<AgentKind | null>(initial)
  const target = targets.find((agent) => agent === selected) ?? targets[0] ?? null
  useEffect(() => { dialog.current?.showModal(); dismissError(); return () => dialog.current?.close() }, [])
  const submit = async () => {
    if (!target || busy || blocker || (mustConfirm && !confirmed) || !confirmQuota(target)) return
    setBusy(true)
    const result = task
      ? await perform((rpc) => rpc.call('tasks.handoff', { id: task.id, agent: target, note, ...startOptions() }))
      : await perform((rpc) => rpc.call('conversations.handoff', { id: conversation.id, agent: target, note, stopRunning: confirmed, ...startOptions() }))
    setBusy(false)
    if (result) onClose()
  }
  if (!target) {
    return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="modal-body">
        <header className="modal-header"><h2>没有可以移交的 Agent</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button></header>
        <p className="muted">这台电脑上只找到了 {AGENT_LABEL[from]}。装好另一个 Agent 后，在 设置 → 智能体 里重新检测，就可以移交了。</p>
        <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>关闭</button><button type="button" className="button primary" onClick={() => { onClose(); setSettingsOpen(true, 'agents') }}>打开智能体设置</button></footer>
      </div>
    </dialog>
  }
  return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onClose() }}>
    <div className="modal-body">
      <header className="modal-header"><h2>移交给 {AGENT_LABEL[target]}</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button></header>
      <p className="muted">{task
        ? '会传递可见消息和补充说明，新 Agent 在任务的 worktree 里接着做，之后这个任务都由它执行。隐藏推理和 provider 私有上下文无法移交；新 Agent 应检查文件、Git 状态和测试结果。'
        : '会传递可见消息、补充说明和所选项目目录（无项目时为 Kando 托管目录）。隐藏推理和 provider 私有上下文无法移交；新 Agent 应检查文件、Git 状态和测试结果。'}</p>
      <label className="modal-field"><span className="modal-label">目标 Agent</span><select className="input" value={target} onChange={(event) => { const next = targets.find((agent) => agent === event.target.value); if (next) setSelected(next) }}>{targets.map((agent) => <option key={agent} value={agent}>{AGENT_LABEL[agent]}</option>)}</select></label>
      <AgentQuotaHint agent={target} />
      <label className="modal-field"><span className="modal-label">补充说明 <span className="modal-optional">[可选]</span></span>
        <textarea className="input modal-textarea" rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {mustConfirm && <label className="conversation-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />确认停止当前 {AGENT_LABEL[from]}，然后启动 {AGENT_LABEL[target]}</label>}
      {blocker && <p className="modal-error" role="alert">还不能移交：{blocker}</p>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy || blocker !== null || (mustConfirm && !confirmed)} onClick={() => void submit()}>移交</button></footer>
    </div>
  </dialog>
}
