import { useEffect, useRef, useState } from 'react'
import { AGENT_KINDS, type AgentKind } from '@kando/protocol'
import { dismissError, perform, selectConversation, setNewConversationOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { AGENT_LABEL } from '../labels'
import { ProjectPicker } from './ProjectPicker'

export function NewConversationDialog() {
  const dialog = useRef<HTMLDialogElement>(null)
  const tasks = useCore((s) => s.tasks)
  const error = useCore((s) => s.error)
  const [agent, setAgent] = useState<AgentKind>(() => defaultAgent(tasks) ?? 'codex')
  const [projectPaths, setProjectPaths] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
    dismissError()
    return () => dialog.current?.close()
  }, [])
  const close = () => setNewConversationOpen(false)
  const create = async () => {
    if (busy) return
    setBusy(true)
    const created = await perform((rpc) => rpc.call('conversations.create', { agent, projectPaths }))
    setBusy(false)
    if (created) { selectConversation(created.id); close() }
  }
  return <dialog ref={dialog} className="modal" onCancel={(event) => { event.preventDefault(); close() }}>
    <div className="modal-body">
      <header className="modal-header"><h2>新建自由会话</h2><button type="button" className="icon-button modal-close" aria-label="关闭" onClick={close}>×</button></header>
      <label className="modal-field"><span className="modal-label">初始 agent</span>
        <select className="input modal-input" value={agent} onChange={(event) => setAgent(event.target.value === 'claude' ? 'claude' : 'codex')}>
          {AGENT_KINDS.map((kind) => <option key={kind} value={kind}>{AGENT_LABEL[kind]}</option>)}
        </select>
      </label>
      <div className="modal-field"><span className="modal-label">项目 <span className="modal-optional">[可选]</span></span>
        <ProjectPicker
          projects={projectPaths.map((projectPath) => ({ path: projectPath, branch: null, worktreePath: null }))}
          onChange={setProjectPaths}
        />
        <span className="muted">{projectPaths.length === 0 ? '不选项目时，使用 Kando 持久工作目录' : '第一个项目是终端当前目录；其他项目可由 agent 直接访问'}</span>
      </div>
      {error && <p className="modal-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button ghost" onClick={close}>取消</button><button type="button" className="button primary" disabled={busy} onClick={() => void create()}>创建并启动</button></footer>
    </div>
  </dialog>
}
