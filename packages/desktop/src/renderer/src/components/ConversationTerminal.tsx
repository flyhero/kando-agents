import { useCallback, useState } from 'react'
import type { ConversationMode } from '@kando/protocol'
import { usePlans } from '../chat-state'
import { selectConversation, setConversationInspectorOpen, useChatSupported, useCore } from '../core-store'
import { conversationState } from '../conversation-state'
import { AGENT_LABEL } from '../labels'
import { projectNames } from './ProjectPicker'
import { BranchStatus } from './BranchStatus'
import { ConversationChat } from './ConversationChat'
import { ConversationInspector } from './ConversationInspector'
import { ConversationTranscript } from './ConversationTranscript'
import { ConversationHandoffDialog } from './ConversationHandoffDialog'
import { continueConversation, deleteConversation, renameConversation, stopConversation } from './ConversationActions'
import { CloseIcon, HandoffIcon, InspectorIcon, MoreIcon, PencilIcon, PlayIcon, StopIcon } from './icons'
import { Popover } from './Popover'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'
import { TitleEditor } from './TitleEditor'

const MODE_ACTION: Record<ConversationMode, string> = { tui: '以终端界面继续', chat: '以聊天界面继续' }

// Deleting sits a click away from the everyday buttons, as a task's does. A stopped terminal
// conversation can continue in either view here (the ▷ button uses the one settings name), and a
// chat one can move to the terminal whenever its agent is not busy.
function MoreMenu({ disabled, onDelete, continueModes, continueDisabled, onContinue }: {
  disabled: boolean
  onDelete: () => void
  continueModes: readonly ConversationMode[]
  continueDisabled: boolean
  onContinue: (mode: ConversationMode) => void
}) {
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
          {continueModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="menu-item"
              disabled={continueDisabled}
              title={continueDisabled ? '等 agent 这一回合结束' : undefined}
              onClick={() => {
                close()
                onContinue(mode)
              }}
            >
              {MODE_ACTION[mode]}
            </button>
          ))}
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

export function ConversationTerminal({ id }: { id: string }) {
  const conversation = useCore((state) => state.conversations[id])
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const inspectorOpen = useCore((state) => state.conversationInspectorOpen)
  const [panelRatio, setPanelRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const chatSupported = useChatSupported()
  const plans = usePlans(id)
  if (!conversation) return null
  const chat = conversation.mode === 'chat'
  // A chat agent starts with the next message and goes when idle: no continue or stop to press.
  const chatBusy = chat && conversation.sessionId !== null && conversation.chat?.turn !== 'idle'
  const continueModes: readonly ConversationMode[] = !chatSupported ? [] : chat ? ['tui'] : conversation.sessionId ? [] : ['tui', 'chat']
  // A managed workspace is Kando's own scratch folder: nothing of the user's to compare, but the
  // inspector still shows the agent's plans.
  const inspectable = conversation.projectPaths.length > 0
  const hasPanel = inspectable || plans.length > 0
  const state = conversationState(conversation)
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
      <span className="conversation-status" data-running={state.running} data-failed={state.failed || undefined} />
      {renaming
        ? <TitleEditor title={conversation.title} label="会话标题" onSave={rename} onDone={() => setRenaming(false)} />
        : <span className="terminal-view-title" title={conversation.title}>{conversation.title}</span>}
      <span className="muted">{AGENT_LABEL[conversation.agent]}</span>
      <span className="muted" title={conversation.projectPaths.join('\n') || conversation.workspacePath}>{projectNames(conversation.projectPaths)}</span>
      <BranchStatus target={{ kind: 'conversation', id }} updatedAt={conversation.updatedAt} />
      <span className={state.failed ? 'conversation-exit-failed' : 'muted'} title={state.detail ?? undefined}>{state.label}</span>
      <div className="toolbar">
        <button type="button" className="tool-button" aria-label="重命名" data-tooltip="重命名" disabled={busy || renaming} onClick={() => setRenaming(true)}><PencilIcon /></button>
        {!chat && !conversation.sessionId && <button type="button" className="tool-button run-button" aria-label="继续" data-tooltip="继续" disabled={busy} onClick={() => void action(() => continueConversation(id))}><PlayIcon /></button>}
        <button type="button" className="tool-button" aria-label="移交给其他智能体" data-tooltip="移交给其他智能体" disabled={busy} onClick={() => setHandoffOpen(true)}><HandoffIcon /></button>
        {!chat && conversation.sessionId && <button type="button" className="tool-button" aria-label="停止会话" data-tooltip="停止会话" disabled={busy} onClick={() => void action(() => stopConversation(id))}><StopIcon /></button>}
        {hasPanel && (
          <button
            type="button"
            className="tool-button"
            aria-label="检查器"
            aria-pressed={inspectorOpen}
            data-tooltip={inspectorOpen ? '收起检查器' : inspectable ? '查看改动' : '查看计划'}
            onClick={() => setConversationInspectorOpen(!inspectorOpen)}
          >
            <InspectorIcon />
          </button>
        )}
        <MoreMenu
          disabled={busy}
          onDelete={remove}
          continueModes={continueModes}
          continueDisabled={chatBusy}
          onContinue={(mode) => void action(() => continueConversation(id, mode))}
        />
        <span className="toolbar-separator" aria-hidden="true" />
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => selectConversation(null)}><CloseIcon /></button>
      </div>
    </header>
    <div className="terminal-body">
      {chat
        ? <ConversationChat conversation={conversation} />
        : <ConversationTranscript key={conversation.sessionId ?? 'history'} id={id} sessionId={conversation.sessionId} />}
      {hasPanel && inspectorOpen && <ConversationInspector conversation={conversation} widthRatio={panelRatio} onWidthRatioChange={setPanelRatio} />}
    </div>
    {handoffOpen && <ConversationHandoffDialog conversation={conversation} onClose={() => setHandoffOpen(false)} />}
  </section>
}
