import type { Conversation, Task } from '@kando/protocol'

// Where a notification leads when clicked.
export type AttentionTarget = { kind: 'task' | 'conversation'; id: string }

export type Notice = { title: string; body: string; target: AttentionTarget }

export type Snapshot = {
  tasks: Readonly<Record<string, Task>>
  conversations: Readonly<Record<string, Conversation>>
  unseen: Readonly<Record<string, true>>
}

const waiting = (conversation: Conversation) => conversation.sessionId !== null && conversation.chat?.turn === 'awaiting'
const working = (conversation: Conversation) => conversation.chat?.turn === 'running' || conversation.chat?.turn === 'awaiting'
const crashed = (conversation: Conversation) => conversation.sessionId === null && (conversation.lastExit?.code ?? 0) !== 0

// How many things wait on the user: an agent asking, a turn that finished while they were
// elsewhere, and a task's agent done with its turn. A task's chat is counted once.
export function attentionCount(s: Snapshot): number {
  const counted = new Set<string>()
  for (const conversation of Object.values(s.conversations)) {
    if (waiting(conversation) || s.unseen[conversation.id]) counted.add(conversation.id)
  }
  let count = counted.size
  for (const task of Object.values(s.tasks)) {
    if (task.awaitingInput && !(task.conversationId && counted.has(task.conversationId))) count += 1
  }
  return count
}

// A task's chat is told of under the task's name, and leads to the task.
function named(conversation: Conversation, tasks: Snapshot['tasks']): { title: string; target: AttentionTarget } {
  const task = conversation.taskId ? tasks[conversation.taskId] : undefined
  return task ? { title: task.title, target: { kind: 'task', id: task.id } } : { title: conversation.title, target: { kind: 'conversation', id: conversation.id } }
}

// What to tell the user about between two states: an agent now waiting on them, a turn over, or
// an agent gone. Judged on the turn, not the task, so a task's chat is told of once.
export function noticesBetween(prev: Snapshot, next: Snapshot): Notice[] {
  const notices: Notice[] = []
  for (const conversation of Object.values(next.conversations)) {
    const before = prev.conversations[conversation.id]
    if (!before || before === conversation) continue
    const { title, target } = named(conversation, next.tasks)
    if (crashed(conversation) && !crashed(before)) {
      notices.push({ title, body: `agent 异常退出（code ${conversation.lastExit?.code}），发消息会重新启动它`, target })
    } else if (waiting(conversation) && !waiting(before)) {
      notices.push({ title, body: 'agent 在等你允许或回答', target })
    } else if (working(before) && !working(conversation)) {
      notices.push({ title, body: 'agent 这一轮做完了', target })
    }
  }
  return notices
}
