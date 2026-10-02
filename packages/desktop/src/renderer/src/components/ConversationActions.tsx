import type { Conversation, ConversationMode } from '@kando/protocol'
import { openConversationDraft, perform, setNewConversationOpen, useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'

// The interface every start takes: the setting, where core can run it.
export function defaultMode(): ConversationMode {
  const chat = useCore.getState().rpc?.features.includes('chat') ?? false
  return chat ? usePreferences.getState().agentView : 'tui'
}

// With chats the default a new conversation opens as a page its first message starts; otherwise
// a dialog asks for its agent and projects.
export function newConversation(): void {
  if (defaultMode() === 'chat') openConversationDraft()
  else setNewConversationOpen(true)
}

// What a start tells core besides its mode: whether this user lets chat stages offer bypass.
export function startOptions(mode: ConversationMode): { mode: ConversationMode; allowBypass?: boolean } {
  const options = useCore.getState().rpc?.features.includes('chat-options') ?? false
  return mode === 'chat' && options ? { mode, allowBypass: usePreferences.getState().allowBypass } : { mode }
}

export function continueConversation(id: string, mode: ConversationMode = defaultMode()) {
  return perform((rpc) => rpc.call('conversations.continue', { id, ...startOptions(mode) }))
}

export function stopConversation(id: string) {
  return perform((rpc) => rpc.call('conversations.stop', { id }))
}

export function renameConversation(id: string, title: string) {
  return perform((rpc) => rpc.call('conversations.rename', { id, title }))
}

export async function deleteConversation(conversation: Conversation): Promise<boolean> {
  if (!window.confirm('删除这条会话及其终端记录？项目目录或 Kando 托管目录都会保留，不会改动其中的文件。')) return false
  return (await perform((rpc) => rpc.call('conversations.delete', { id: conversation.id }))) !== null
}

// The row's right-click menu: the header's actions, and the one place a conversation is deleted.
export function ConversationContextMenu({ conversation, at, onClose, onRename, onHandoff }: {
  conversation: Conversation
  at: MenuPoint
  onClose: () => void
  onRename: () => void
  onHandoff: () => void
}) {
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <ContextMenu at={at} label={`会话「${conversation.title}」的操作`} onClose={onClose}>
      {conversation.sessionId
        ? <MenuItem label="停止会话" onSelect={pick(() => void stopConversation(conversation.id))} />
        : <MenuItem label="继续" onSelect={pick(() => void continueConversation(conversation.id))} />}
      <MenuItem label="移交给其他智能体…" onSelect={pick(onHandoff)} />
      <div className="menu-separator" role="separator" />
      <MenuItem label="重命名" onSelect={pick(onRename)} />
      <div className="menu-separator" role="separator" />
      <MenuItem label="删除会话" danger onSelect={pick(() => void deleteConversation(conversation))} />
    </ContextMenu>
  )
}
