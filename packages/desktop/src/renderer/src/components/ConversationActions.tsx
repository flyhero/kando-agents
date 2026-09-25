import type { Conversation } from '@kando/protocol'
import { perform } from '../core-store'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'

export function continueConversation(id: string) {
  return perform((rpc) => rpc.call('conversations.continue', { id }))
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

// The row's right-click menu: the same actions as the conversation's header.
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
