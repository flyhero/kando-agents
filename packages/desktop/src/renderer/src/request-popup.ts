import { PLAN_TOOLS, type Conversation, type ConversationRequest } from '@kando/protocol'
import { actionableItems, waiting, type ActionableTarget, type Snapshot } from './attention'

// One conversation on the card of waiting requests, under its task's name when it has one.
export type PopupEntry = { conversationId: string; title: string; target: ActionableTarget; request: ConversationRequest }

// What a close puts away: the conversation's requests as they stood, so one more coming up, or
// the oldest answered elsewhere, brings it back.
export const popupKey = (conversationId: string, request: ConversationRequest): string =>
  `${conversationId}:${request.requestId}:${request.open}`

// A turn held up on the user, not a question asked in passing that nothing waits on.
const blocking = (conversation: Conversation): boolean => waiting(conversation) && conversation.chat?.request?.async !== true

// What the card offers, longest waiting first: every chat whose turn waits on the user, a task's
// under the task, less those the user closed the card on.
export function popupQueue(s: Pick<Snapshot, 'tasks' | 'conversations'>, closed: ReadonlySet<string>): PopupEntry[] {
  return actionableItems(s).flatMap((item) => {
    const { conversationId, request } = item
    if (item.primaryReason !== 'awaiting' || !conversationId || !request || request.async) return []
    if (closed.has(popupKey(conversationId, request))) return []
    return [{ conversationId, title: item.title, target: item.target, request }]
  })
}

export function popupLabel(request: ConversationRequest): string {
  if (request.kind === 'question') return '有个问题'
  return request.tool !== null && PLAN_TOOLS.has(request.tool) ? '计划待批准' : '等你允许'
}

// Whether the card is worth bringing up: a chat now held up on the user, or held up on something
// more than before. A chat seen for the first time is not news (the list arriving on connect).
export function newlyWaiting(prev: Snapshot['conversations'], next: Snapshot['conversations']): boolean {
  return Object.values(next).some((conversation) => {
    const before = prev[conversation.id]
    if (!before || before === conversation || !blocking(conversation)) return false
    if (!blocking(before)) return true
    const was = before.chat?.request
    const is = conversation.chat?.request
    return was?.requestId !== is?.requestId || (is?.open ?? 0) > (was?.open ?? 0)
  })
}
