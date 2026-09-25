import type { AgentKind, Task } from '@kando/protocol'
import { usePreferences } from './preferences'

// By default a new task takes the agent the latest task picked, which is usually right.
export function defaultAgent(tasks: Record<string, Task>): AgentKind | null {
  const preferred = usePreferences.getState().defaultAgent
  if (preferred === 'none') {
    return null
  }
  if (preferred !== 'recent') {
    return preferred
  }
  return (
    Object.values(tasks)
      .filter((task) => task.agent !== null)
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.agent ?? null
  )
}
