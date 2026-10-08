import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@kando/protocol'
import { dismissError, perform, setSettingsOpen, useCore } from '../core-store'
import { otherInstalledAgent, useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { AgentQuotaHint, confirmQuota } from './AgentQuota'
import { startOptions } from './ConversationActions'

export function ConversationHandoffDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // An idle agent has nothing to lose, so core lets it go without asking.
  const mustConfirm = conversation.sessionId !== null && conversation.chat?.turn !== 'idle'
  const error = useCore((s) => s.error)
  // Another agent that is installed here; none, and there is nowhere to hand off to.
  const target = otherInstalledAgent(conversation.agent, useInstalledAgents())
  useEffect(() => { dialog.current?.showModal(); dismissError(); return () => dialog.current?.close() }, [])
  const submit = async () => {
    if (!target || busy || (mustConfirm && !confirmed) || !confirmQuota(target)) return
    setBusy(true)
    const result = await perform((rpc) => rpc.call('conversations.handoff', { id: conversation.id, agent: target, note, stopRunning: confirmed, ...startOptions() }))
    setBusy(false)
    if (result) onClose()
  }
  if (!target) {
    return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="modal-body">
        <header className="modal-header"><h2>没有可以移交的 Agent</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button></header>
        <p className="muted">这台电脑上只找到了 {AGENT_LABEL[conversation.agent]}。装好另一个 Agent 后，在 设置 → 智能体 里重新检测，就可以移交了。</p>
        <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>关闭</button><button type="button" className="button primary" onClick={() => { onClose(); setSettingsOpen(true, 'agents') }}>打开智能体设置</button></footer>
      </div>
    </dialog>
  }
  return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onClose() }}>
    <div className="modal-body">
      <header className="modal-header"><h2>移交给 {AGENT_LABEL[target]}</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button></header>
      <p className="muted">会传递可见消息、补充说明和所选项目目录（无项目时为 Kando 托管目录）。隐藏推理和 provider 私有上下文无法移交；新 Agent 应检查文件、Git 状态和测试结果。</p>
      <AgentQuotaHint agent={target} />
      <label className="modal-field"><span className="modal-label">补充说明 <span className="modal-optional">[可选]</span></span>
        <textarea className="input modal-textarea" rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {mustConfirm && <label className="conversation-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />确认停止当前 {AGENT_LABEL[conversation.agent]}，然后启动 {AGENT_LABEL[target]}</label>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy || (mustConfirm && !confirmed)} onClick={() => void submit()}>移交</button></footer>
    </div>
  </dialog>
}
