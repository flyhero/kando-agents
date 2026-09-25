import { useCallback, useEffect, useState } from 'react'
import type { ProjectHead } from '@kando/protocol'
import { selectConversation, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { projectName, projectNames } from './ProjectPicker'
import { ConversationTranscript } from './ConversationTranscript'
import { ConversationHandoffDialog } from './ConversationHandoffDialog'
import { continueConversation, deleteConversation, renameConversation, stopConversation } from './ConversationActions'
import { CloseIcon, HandoffIcon, MoreIcon, PencilIcon, PlayIcon, StopIcon } from './icons'
import { Popover } from './Popover'
import { TitleEditor } from './TitleEditor'

// Deleting sits a click away from the everyday buttons, as a task's does.
function MoreMenu({ disabled, onDelete }: { disabled: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button"
        aria-label="更多操作"
        data-tooltip="更多操作"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreIcon />
      </button>
      {open && (
        <Popover label="更多操作" onClose={close}>
          <button
            type="button"
            className="menu-item menu-item-danger"
            onClick={() => {
              close()
              onDelete()
            }}
          >
            删除会话
          </button>
        </Popover>
      )}
    </span>
  )
}

// Asked again on open, when the window regains focus, and whenever the conversation changes,
// which covers every agent turn and exit. An older core without the method shows no branch.
function useProjectHeads(id: string, updatedAt: number | undefined): ProjectHead[] {
  const rpc = useCore((state) => state.rpc)
  const [heads, setHeads] = useState<{ id: string; heads: ProjectHead[] }>({ id: '', heads: [] })
  const [focusCount, setFocusCount] = useState(0)
  useEffect(() => {
    const onFocus = () => setFocusCount((count) => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('conversations.branches', { id })
      .catch(() => [])
      .then((found) => {
        if (current) setHeads({ id, heads: found })
      })
    return () => {
      current = false
    }
  }, [rpc, id, updatedAt, focusCount])
  return heads.id === id ? heads.heads : []
}

function headLabel(head: ProjectHead): string {
  if (!head.branch) return '不是 git 仓库'
  return head.detached ? `${head.branch}（分离 HEAD）` : head.branch
}

export function ConversationTerminal({ id }: { id: string }) {
  const conversation = useCore((state) => state.conversations[id])
  // The first project is the agent's working directory; the rest go in the tooltip.
  const heads = useProjectHeads(id, conversation?.updatedAt)
  const head = heads[0]
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!conversation) return null
  const action = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    await run()
    setBusy(false)
  }
  const rename = (title: string) => void action(() => renameConversation(id, title))
  const remove = () => void action(async () => {
    if (await deleteConversation(conversation)) selectConversation(null)
  })
  return <section className="detail terminal-view conversation-view" aria-label={`${conversation.title} 的自由会话`}>
    <header className="detail-header conversation-header">
      <span className="conversation-status" data-running={conversation.sessionId !== null} />
      {renaming
        ? <TitleEditor title={conversation.title} label="会话标题" onSave={rename} onDone={() => setRenaming(false)} />
        : <span className="terminal-view-title" title={conversation.title}>{conversation.title}</span>}
      <span className="muted">{AGENT_LABEL[conversation.agent]}</span>
      <span className="muted" title={conversation.projectPaths.join('\n') || conversation.workspacePath}>{projectNames(conversation.projectPaths)}</span>
      {head?.branch && (
        <span className="project-branch mono" title={heads.map((each) => `${projectName(each.path)}：${headLabel(each)}`).join('\n')}>
          {headLabel(head)}
        </span>
      )}
      <span className="muted">{conversation.sessionId ? '运行中' : '未运行'}</span>
      <div className="toolbar">
        <button type="button" className="tool-button" aria-label="重命名" data-tooltip="重命名" disabled={busy || renaming} onClick={() => setRenaming(true)}><PencilIcon /></button>
        {!conversation.sessionId && <button type="button" className="tool-button run-button" aria-label="继续" data-tooltip="继续" disabled={busy} onClick={() => void action(() => continueConversation(id))}><PlayIcon /></button>}
        <button type="button" className="tool-button" aria-label="移交给其他智能体" data-tooltip="移交给其他智能体" disabled={busy} onClick={() => setHandoffOpen(true)}><HandoffIcon /></button>
        {conversation.sessionId && <button type="button" className="tool-button" aria-label="停止会话" data-tooltip="停止会话" disabled={busy} onClick={() => void action(() => stopConversation(id))}><StopIcon /></button>}
        <MoreMenu disabled={busy} onDelete={remove} />
        <span className="toolbar-separator" aria-hidden="true" />
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => selectConversation(null)}><CloseIcon /></button>
      </div>
    </header>
    <div className="terminal-body"><ConversationTranscript key={conversation.sessionId ?? 'history'} id={id} sessionId={conversation.sessionId} /></div>
    {handoffOpen && <ConversationHandoffDialog conversation={conversation} onClose={() => setHandoffOpen(false)} />}
  </section>
}
