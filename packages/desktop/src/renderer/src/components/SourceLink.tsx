import type { Task } from '@kando/protocol'
import { ExternalIcon } from './icons'

// The issue an imported task came from, one click from the task itself.
export function SourceLink({ task }: { task: Task }) {
  if (!task.source) {
    return null
  }
  return (
    <a className="source-link" href={task.source.url} target="_blank" rel="noreferrer" data-tooltip={`在 ${task.source.name} 中打开`} data-tooltip-align="start">
      {task.source.key}
      <ExternalIcon />
    </a>
  )
}
