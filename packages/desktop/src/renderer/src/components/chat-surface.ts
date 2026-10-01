import { createContext, useContext } from 'react'
import type { Conversation } from '@kando/protocol'
import type { PlanItem } from '../chat-state'
import { showBrowserPanel, showConversationChanges, showConversationPlan } from '../core-store'
import type { BranchTarget } from './BranchStatus'
import { continueConversation } from './ConversationActions'

// What the chat view does beyond itself, which a free conversation and a task's chat do differently:
// where its plans and changes open, how an agent gets ready for a message, and what a plan offers.
export type ChatSurface = {
  // The side panel on a plan (by item key; null for the newest), or on the changes.
  showPlan(key: string | null): void
  showChanges(): void
  // The browser panel, on this conversation's tab.
  showBrowser(): void
  // Whose uncommitted changes the chip counts, and what the chip says of them; null for none.
  changes: BranchTarget | null
  changesHint: string
  // Readies an agent for a message, when none runs or when its owner needs a word first; false if
  // that failed and the message should stay.
  prepareSend(stopped: boolean): Promise<boolean>
  // Why nothing can be sent now, or null.
  sendBlocker: string | null
  // Keeps a plan for later, where the chat may only plan; null elsewhere.
  savePlan: ((item: PlanItem) => Promise<void>) | null
  // A word on a plan the chat's owner kept, or null.
  planNote(item: PlanItem): string | null
}

export const ChatSurfaceContext = createContext<ChatSurface | null>(null)

export function useChatSurface(): ChatSurface {
  const surface = useContext(ChatSurfaceContext)
  if (!surface) throw new Error('the chat view is shown outside a chat surface')
  return surface
}

// A free conversation: its own inspector, its projects' changes, and chat mode to continue in.
export function conversationSurface(conversation: Conversation): ChatSurface {
  return {
    showPlan: showConversationPlan,
    showChanges: showConversationChanges,
    showBrowser: () => showBrowserPanel(conversation.id),
    changes: conversation.projectPaths.length > 0 ? { kind: 'conversation', id: conversation.id } : null,
    changesHint: '项目里还没提交的改动，也可能有你自己的；点开检查器看',
    prepareSend: async (stopped) => !stopped || Boolean(await continueConversation(conversation.id, 'chat')),
    sendBlocker: null,
    savePlan: null,
    planNote: () => null
  }
}
