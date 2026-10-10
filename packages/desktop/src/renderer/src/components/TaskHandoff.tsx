import { useCallback, useState, type ReactElement } from 'react'
import { checkTaskHandoff, type AgentKind, type Task } from '@kando/protocol'
import { useCore, useTaskHandoffSupported } from '../core-store'
import { reasonText } from '../labels'
import { ConversationHandoffDialog } from './ConversationHandoffDialog'

export type TaskHandoff = {
  // A core that hands tasks off, and a chat to hand.
  available: boolean
  // Why it cannot go now, or null.
  blocker: string | null
  // Opens the dialog, on the agent already picked if there is one.
  open: (agent?: AgentKind) => void
  dialog: ReactElement | null
}

// Handing a task's chat to another agent, from wherever the task offers it.
export function useTaskHandoff(task: Task | undefined): TaskHandoff {
  const supported = useTaskHandoffSupported()
  const conversation = useCore((s) => (task?.conversationId ? s.conversations[task.conversationId] : undefined))
  const tasks = useCore((s) => s.tasks)
  const [asked, setAsked] = useState<{ agent: AgentKind | null } | null>(null)
  const open = useCallback((agent?: AgentKind) => setAsked({ agent: agent ?? null }), [])
  if (!task || !conversation) return { available: false, blocker: null, open, dialog: null }
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const found = checkTaskHandoff(task, dependencies, conversation.sessionId ? (conversation.chat?.turn ?? null) : null)
  const blocker = found && reasonText(found, found)
  const dialog = asked && (
    <ConversationHandoffDialog conversation={conversation} task={task} initial={asked.agent} blocker={blocker} onClose={() => setAsked(null)} />
  )
  return { available: supported, blocker, open, dialog }
}
