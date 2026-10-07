import { useCallback, useEffect, useState } from 'react'
import { usePlans } from '../chat-state'
import { markRoutineRunSeen, selectConversation, setConversationInspectorOpen, setRoutinesOpen, useCore, useWireLogShown } from '../core-store'
import { conversationState } from '../conversation-state'
import { AGENT_LABEL } from '../labels'
import { primaryProjectName } from './ProjectPicker'
import { BranchStatus } from './BranchStatus'
import { ConversationChat } from './ConversationChat'
import { ConversationInspector } from './ConversationInspector'
import { ConversationStatus } from './ConversationStatus'
import { ConversationHandoffDialog } from './ConversationHandoffDialog'
import { renameConversation } from './ConversationActions'
import { CloseIcon, HandoffIcon, InspectorIcon, PencilIcon } from './icons'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'
import { TitleEditor } from './TitleEditor'

// Where a fork came from: a way back while the source is still here.
function ForkOrigin({ id }: { id: string }) {
  const source = useCore((state) => state.conversations[id])
  return (
    <span className="muted conversation-origin">
      {source
        ? <>从「<button type="button" className="link-button" onClick={() => selectConversation(id)}>{source.title}</button>」fork</>
        : 'fork 自一条已删除的会话'}
    </span>
  )
}

export function ConversationView({ id }: { id: string }) {
  const conversation = useCore((state) => state.conversations[id])
  const [handoffOpen, setHandoffOpen] = useState(false)
  // Stable, so the chat's surface is not rebuilt on every render.
  const openHandoff = useCallback(() => setHandoffOpen(true), [])
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const inspectorOpen = useCore((state) => state.conversationInspectorOpen)
  const [panelRatio, setPanelRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const plans = usePlans(id)
  const wire = useWireLogShown()
  const routine = useCore((state) => state.routines.find((each) => each.id === conversation?.routineId) ?? null)
  const routineId = conversation?.routineId ?? null
  const turn = conversation?.chat?.turn ?? null
  // Looking at a routine's conversation, with the window in front, is looking at its run: when
  // it opens, when the window comes back, and when the run ends while it is in view.
  useEffect(() => {
    if (!routineId) return
    const look = () => { if (document.hasFocus()) markRoutineRunSeen(id) }
    look()
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
  }, [id, routineId, turn])
  if (!conversation) return null
  // The agent starts with the next message and goes when idle: no continue or stop to press.
  // A managed workspace is Kando's own scratch folder: nothing of the user's to compare, but the
  // inspector still shows the agent's plans.
  const inspectable = conversation.projectPaths.length > 0
  const hasPanel = inspectable || plans.length > 0 || wire
  const state = conversationState(conversation)
  const action = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    await run()
    setBusy(false)
  }
  const rename = (title: string) => void action(() => renameConversation(id, title))
  return <section className="detail terminal-view conversation-view" aria-label={`${conversation.title} 的会话`}>
    <header className="detail-header conversation-header">
      <ConversationStatus conversation={conversation} />
      <div className="header-meta">
        {renaming
          ? <TitleEditor title={conversation.title} label="会话标题" onSave={rename} onDone={() => setRenaming(false)} />
          : <span className="terminal-view-title" title={conversation.title}>{conversation.title}</span>}
        <span className="muted">{AGENT_LABEL[conversation.agent]}</span>
        <span className="muted" title={conversation.projectPaths.join('\n') || conversation.workspacePath}>{primaryProjectName(conversation.projectPaths)}</span>
        <BranchStatus target={{ kind: 'conversation', id }} updatedAt={conversation.updatedAt} />
        <span className={state.failed ? 'conversation-exit-failed' : 'muted'} title={state.detail ?? undefined}>{state.label}</span>
        {conversation.forkedFromId && <ForkOrigin id={conversation.forkedFromId} />}
        {conversation.routineId && (
          <span className="muted conversation-origin">
            来自定时任务{routine ? `「${routine.title}」` : ''} ·
            <button type="button" className="link-button" onClick={() => setRoutinesOpen(true)}>回到定时任务</button>
          </span>
        )}
      </div>
      <div className="toolbar">
        <button type="button" className="tool-button" aria-label="重命名" data-tooltip="重命名" disabled={busy || renaming} onClick={() => setRenaming(true)}><PencilIcon /></button>
        <button type="button" className="tool-button" aria-label="移交给其他智能体" data-tooltip="移交给其他智能体" disabled={busy} onClick={() => setHandoffOpen(true)}><HandoffIcon /></button>
        {hasPanel && (
          <button
            type="button"
            className="tool-button"
            aria-label="检查器"
            aria-pressed={inspectorOpen}
            data-tooltip={inspectorOpen ? '收起检查器' : inspectable ? '查看改动' : plans.length > 0 ? '查看计划' : '查看原始数据'}
            onClick={() => setConversationInspectorOpen(!inspectorOpen)}
          >
            <InspectorIcon />
          </button>
        )}
        <span className="toolbar-separator" aria-hidden="true" />
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => selectConversation(null)}><CloseIcon /></button>
      </div>
    </header>
    <div className="terminal-body">
      <ConversationChat conversation={conversation} onHandoff={openHandoff} />
      {hasPanel && inspectorOpen && <ConversationInspector conversation={conversation} widthRatio={panelRatio} onWidthRatioChange={setPanelRatio} wire={wire} />}
    </div>
    {handoffOpen && <ConversationHandoffDialog conversation={conversation} onClose={() => setHandoffOpen(false)} />}
  </section>
}
