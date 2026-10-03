import type { Task } from '@kando/protocol'

export function hasTaskAlerts(task: Task): boolean {
  return task.awaitingInput
}

// What needs the user's eye beyond the status: an agent waiting on them.
export function TaskAlerts({ task }: { task: Task }) {
  return task.awaitingInput && (
    <span className="task-tag task-tag-awaiting" title="agent 这一轮做完了，等你回复或确认">
      等你回复
    </span>
  )
}
