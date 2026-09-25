import type { Conversation } from '@kando/protocol'

export type ConversationState = { label: string; running: boolean; failed: boolean; detail: string | null }

// One wording for the list, the header and grouping. "Not running" alone hid whether the agent
// finished, was stopped, crashed at once or never started.
export function conversationState(conversation: Conversation): ConversationState {
  const { sessionId, lastExit } = conversation
  if (sessionId) return { label: '运行中', running: true, failed: false, detail: null }
  // An older core sends no lastExit, so there is nothing more to say than before.
  if (lastExit === undefined) return { label: '未运行', running: false, failed: false, detail: null }
  if (lastExit === null) return { label: '未启动', running: false, failed: false, detail: null }
  if (lastExit.code === null) return { label: '已停止', running: false, failed: false, detail: 'agent 被停止了' }
  if (lastExit.code === 0) return { label: '已退出', running: false, failed: false, detail: 'agent 正常退出（code 0）' }
  return { label: '异常退出', running: false, failed: true, detail: `agent 异常退出（code ${lastExit.code}）` }
}
