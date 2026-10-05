import type { Conversation } from '@kando/protocol'

export type ConversationState = { label: string; running: boolean; failed: boolean; detail: string | null }

// The mark before a conversation's name, most urgent first: it waits on the user, its agent is at
// work, it failed, a turn finished while the user was elsewhere, or nothing is going on.
export type ConversationGlyph = 'awaiting' | 'running' | 'failed' | 'unseen' | 'idle'

export function conversationGlyph(conversation: Conversation, unseen: boolean): ConversationGlyph {
  const state = conversationState(conversation)
  if (conversation.sessionId && conversation.chat?.turn === 'awaiting') return 'awaiting'
  if (state.running && conversation.chat?.turn !== 'idle') return 'running'
  if (state.failed) return 'failed'
  return unseen ? 'unseen' : 'idle'
}

// How long ago, as the list says it: short, and a date past a week.
export function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

// One wording for the list, the header and grouping. A conversation has no stopped state: its
// agent starts again with the next message and goes when idle, so what it is doing, or how it
// last failed, is all there is to say.
export function conversationState(conversation: Conversation): ConversationState {
  const { sessionId, lastExit, chat } = conversation
  if (sessionId && chat?.turn === 'awaiting') return { label: '等待确认', running: true, failed: false, detail: 'Agent 在等你允许或回答' }
  if (sessionId && chat?.turn === 'running') return { label: '运行中', running: true, failed: false, detail: null }
  if (!sessionId && lastExit?.code) return { label: '异常退出', running: false, failed: true, detail: `Agent 异常退出（code ${lastExit.code}），发消息会重新启动它` }
  return { label: '空闲', running: false, failed: false, detail: '发消息就会接着聊' }
}
