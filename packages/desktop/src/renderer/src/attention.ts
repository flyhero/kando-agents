import { isScheduleOpen, limitOf, PLAN_TOOLS, type AgentKind, type Conversation, type ConversationRequest, type Routine, type ScheduledRun, type Task } from '@kando/protocol'

// What waits on the user: a task or a conversation.
export type ActionableTarget = { kind: 'task' | 'conversation'; id: string }
// Where a notification leads when clicked: one of those, or the page of routines (for a
// routine's run that has no conversation to show).
export type AttentionTarget = ActionableTarget | { kind: 'routines' }

export const targetKey = (target: AttentionTarget): string => (target.kind === 'routines' ? 'routines' : `${target.kind}:${target.id}`)

export type Notice = { title: string; body: string; target: AttentionTarget }

export type Snapshot = {
  tasks: Readonly<Record<string, Task>>
  conversations: Readonly<Record<string, Conversation>>
  unseen: Readonly<Record<string, true>>
  // The routines, each with how many of its runs are unread; a core without routines has none.
  routines?: readonly Routine[]
}

const waiting = (conversation: Conversation) => conversation.sessionId !== null && conversation.chat?.turn === 'awaiting'
const working = (conversation: Conversation) => conversation.chat?.turn === 'running' || conversation.chat?.turn === 'awaiting'
const crashed = (conversation: Conversation) => conversation.sessionId === null && (conversation.lastExit?.code ?? 0) !== 0

export type ActionableReason = 'awaiting' | 'crashed' | 'review' | 'reply'
export type ActionableItem = {
  target: ActionableTarget
  title: string
  agent: AgentKind | null
  projectPaths: string[]
  conversationId: string | null
  primaryReason: ActionableReason
  reasons: ActionableReason[]
  // What the agent asks, while it waits; null when the core does not say.
  request: ConversationRequest | null
  updatedAt: number
}

// An approval the list can answer as it stands: allowed this once or denied. A plan, a question,
// or anything with no plain allow wants the chat.
export function quickApproval(request: ConversationRequest | null): request is ConversationRequest & { tool: string } {
  return request?.kind === 'approval' && request.tool !== null && !PLAN_TOOLS.has(request.tool) && request.decisions.includes('allow')
}

const requestOf = (conversation: Conversation | undefined, reasons: readonly ActionableReason[]) =>
  reasons[0] === 'awaiting' ? conversation?.chat?.request ?? null : null

const REASON_PRIORITY: Record<ActionableReason, number> = { awaiting: 0, crashed: 1, review: 2, reply: 3 }

function chatReasons(conversation: Conversation | undefined): ActionableReason[] {
  if (!conversation) return []
  if (waiting(conversation)) return ['awaiting']
  if (crashed(conversation)) return ['crashed']
  return []
}

// Limited cores must not depend on which task chats this window happened to open.
export function actionableItems(s: Pick<Snapshot, 'tasks' | 'conversations'> & { schedules?: readonly ScheduledRun[] }, includeTaskSummaries = true): ActionableItem[] {
  const items: ActionableItem[] = []
  const automaticResumes = new Set((s.schedules ?? []).flatMap((run) =>
    (run.target.kind === 'conversation' || run.target.kind === 'resume') && isScheduleOpen(run) && limitOf(run.target) ? [run.target.conversationId] : []
  ))
  const owned = new Set<string>()
  const byTask = new Map<string, Conversation>()
  for (const conversation of Object.values(s.conversations)) {
    if (conversation.taskId) {
      owned.add(conversation.id)
      byTask.set(conversation.taskId, conversation)
    }
  }
  for (const task of Object.values(s.tasks)) {
    if (task.conversationId) owned.add(task.conversationId)
    if (task.status === 'done' || task.status === 'abandoned') continue
    const conversation = includeTaskSummaries ? (task.conversationId ? s.conversations[task.conversationId] : undefined) ?? byTask.get(task.id) : undefined
    const reasons = chatReasons(conversation)
    if (task.status === 'review') reasons.push('review')
    if (task.awaitingInput && conversation?.chat?.turn !== 'running' && !reasons.includes('awaiting') && !reasons.includes('crashed') &&
      !automaticResumes.has(task.conversationId ?? conversation?.id ?? '')) reasons.push('reply')
    const primaryReason = reasons[0]
    if (!primaryReason) continue
    items.push({
      target: { kind: 'task', id: task.id }, title: task.title, agent: task.agent,
      projectPaths: task.repos.map((repo) => repo.path),
      conversationId: task.conversationId ?? conversation?.id ?? null,
      primaryReason, reasons, request: requestOf(conversation, reasons), updatedAt: task.updatedAt
    })
  }
  for (const conversation of Object.values(s.conversations)) {
    if (owned.has(conversation.id)) continue
    const reasons = chatReasons(conversation)
    const primaryReason = reasons[0]
    if (!primaryReason) continue
    items.push({
      target: { kind: 'conversation', id: conversation.id }, title: conversation.title,
      agent: conversation.agent, projectPaths: conversation.projectPaths, conversationId: conversation.id,
      primaryReason, reasons, request: requestOf(conversation, reasons), updatedAt: conversation.updatedAt
    })
  }
  return items.sort((a, b) =>
    REASON_PRIORITY[a.primaryReason] - REASON_PRIORITY[b.primaryReason] || a.updatedAt - b.updatedAt ||
    targetKey(a.target).localeCompare(targetKey(b.target))
  )
}

// How many things wait on the user: an agent asking, a turn that finished while they were
// elsewhere, a task's agent done with its turn, and a routine's runs not yet looked at. A task's
// chat is counted once; a routine's conversation counts through the routine, which keeps the
// unread state, not through what this window saw.
export function attentionCount(s: Snapshot): number {
  const counted = new Set<string>()
  for (const conversation of Object.values(s.conversations)) {
    if (conversation.routineId) continue
    if (waiting(conversation) || s.unseen[conversation.id]) counted.add(conversation.id)
  }
  let count = counted.size
  for (const task of Object.values(s.tasks)) {
    if (task.awaitingInput && !(task.conversationId && counted.has(task.conversationId))) count += 1
  }
  for (const routine of s.routines ?? []) count += routine.unread
  return count
}

// A task's chat is told of under the task's name, and leads to the task.
function named(conversation: Conversation, tasks: Snapshot['tasks']): { title: string; target: AttentionTarget } {
  const task = conversation.taskId ? tasks[conversation.taskId] : undefined
  return task ? { title: task.title, target: { kind: 'task', id: task.id } } : { title: conversation.title, target: { kind: 'conversation', id: conversation.id } }
}

// What to tell the user about between two states: an agent now waiting on them, a turn over, or
// an agent gone. Judged on the turn, not the task, so a task's chat is told of once. A routine's
// conversation is told of through its run (routineNoticesBetween), not here.
export function noticesBetween(prev: Snapshot, next: Snapshot): Notice[] {
  const notices: Notice[] = []
  for (const conversation of Object.values(next.conversations)) {
    const before = prev.conversations[conversation.id]
    if (!before || before === conversation || conversation.routineId) continue
    const { title, target } = named(conversation, next.tasks)
    if (crashed(conversation) && !crashed(before)) {
      notices.push({ title, body: `Agent 异常退出（code ${conversation.lastExit?.code}），发消息会重新启动它`, target })
    } else if (waiting(conversation) && !waiting(before)) {
      notices.push({ title, body: 'Agent 在等你允许或回答', target })
    } else if (working(before) && !working(conversation)) {
      notices.push({ title, body: 'Agent 这一轮做完了', target })
    }
  }
  return notices
}
