import type { AgentKind, Task } from '@kando/protocol'
import { useCore } from './core-store'
import { installedAgents } from './installed-agents'
import { usePreferences } from './preferences'

// By default a new task takes the agent the latest task picked, which is usually right. An agent
// that is not installed here is never the default: the only one that is stands in, when there
// is exactly one, and otherwise the choice is left open.
export function defaultAgent(tasks: Record<string, Task>): AgentKind | null {
  const preferred = usePreferences.getState().defaultAgent
  if (preferred === 'none') {
    return null
  }
  const installed = installedAgents(useCore.getState().environment)
  const wanted =
    preferred !== 'recent'
      ? preferred
      : Object.values(tasks)
          .filter((task) => task.agent !== null)
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.agent ?? null
  if (wanted && installed.includes(wanted)) return wanted
  return installed.length === 1 ? installed[0]! : null
}
