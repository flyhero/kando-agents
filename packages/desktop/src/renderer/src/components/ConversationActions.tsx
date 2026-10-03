import type { Conversation } from '@kando/protocol'
import { openConversationDraft, perform, useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { confirmQuota } from './AgentQuota'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { otherInstalledAgent, useInstalledAgents } from '../installed-agents'

// A new conversation opens as a page its first message starts.
export function newConversation(): void {
  openConversationDraft()
}

// What a start tells core: whether this user lets it offer bypass.
export function startOptions(): { allowBypass?: boolean } {
  const options = useCore.getState().rpc?.features.includes('chat-options') ?? false
  return options ? { allowBypass: usePreferences.getState().allowBypass } : {}
}

export function continueConversation(id: string) {
  const agent = useCore.getState().conversations[id]?.agent
  if (agent && !confirmQuota(agent)) return Promise.resolve(null)
  return perform((rpc) => rpc.call('conversations.continue', { id, ...startOptions() }))
}

export function stopConversation(id: string) {
  return perform((rpc) => rpc.call('conversations.stop', { id }))
}

export function renameConversation(id: string, title: string) {
  return perform((rpc) => rpc.call('conversations.rename', { id, title }))
}

export async function deleteConversation(conversation: Conversation): Promise<boolean> {
  if (!window.confirm('删除这条会话及其聊天记录？项目目录或 Kando 托管目录都会保留，不会改动其中的文件。')) return false
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
  // Offered only while another agent is installed to take the work.
  const other = otherInstalledAgent(conversation.agent, useInstalledAgents())
  return (
    <ContextMenu at={at} label={`会话「${conversation.title}」的操作`} onClose={onClose}>
      {conversation.sessionId && <MenuItem label="停止会话" onSelect={pick(() => void stopConversation(conversation.id))} />}
      {other && <MenuItem label="移交给其他智能体…" onSelect={pick(onHandoff)} />}
      <div className="menu-separator" role="separator" />
      <MenuItem label="重命名" onSelect={pick(onRename)} />
      <div className="menu-separator" role="separator" />
      <MenuItem label="删除会话" danger onSelect={pick(() => void deleteConversation(conversation))} />
    </ContextMenu>
  )
}
