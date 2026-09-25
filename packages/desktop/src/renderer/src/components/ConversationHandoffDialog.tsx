import { useEffect, useRef, useState } from 'react'
import type { AgentKind, Conversation } from '@kando/protocol'
import { dismissError, perform, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'

export function ConversationHandoffDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const error = useCore((s) => s.error)
  const target: AgentKind = conversation.agent === 'claude' ? 'codex' : 'claude'
  useEffect(() => { dialog.current?.showModal(); dismissError(); return () => dialog.current?.close() }, [])
  const submit = async () => {
    if (busy || (conversation.sessionId && !confirmed)) return
    setBusy(true)
    const result = await perform((rpc) => rpc.call('conversations.handoff', { id: conversation.id, agent: target, note, stopRunning: confirmed }))
    setBusy(false)
    if (result) onClose()
  }
  return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); onClose() }}>
    <div className="modal-body">
      <header className="modal-header"><h2>移交给 {AGENT_LABEL[target]}</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button></header>
      <p className="muted">会传递可见消息、补充说明和所选项目目录（无项目时为 Kando 托管目录）。隐藏推理和 provider 私有上下文无法移交；新 agent 应检查文件、Git 状态和测试结果。</p>
      <label className="modal-field"><span className="modal-label">补充说明 <span className="modal-optional">[可选]</span></span>
        <textarea className="input modal-textarea" rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {conversation.sessionId && <label className="conversation-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />确认停止当前 {AGENT_LABEL[conversation.agent]}，然后启动 {AGENT_LABEL[target]}</label>}
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={busy || Boolean(conversation.sessionId && !confirmed)} onClick={() => void submit()}>移交</button></footer>
    </div>
  </dialog>
}
