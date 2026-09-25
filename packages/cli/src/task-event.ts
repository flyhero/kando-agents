import { connectRpc, coreUrl, type AgentKind, type TaskSession } from '@kando/protocol'
import { readCoreEndpoint } from '@kando/protocol/node'
import { isCodexTitleTurn } from './codex-title-turn'

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

// What an agent hook event says about the user: true when the agent now waits for them (its turn
// ended, or it asks for permission), false when a new turn began, null when it says nothing.
export function parseTaskEvent(agent: AgentKind, input: unknown): boolean | null {
  if (agent === 'codex') {
    // The title turn ends seconds into the task's first turn, while the agent is still working.
    if (isCodexTitleTurn(input)) return null
    return field(input, 'type') === 'agent-turn-complete' ? true : null
  }
  switch (field(input, 'hook_event_name')) {
    case 'Stop':
    case 'StopFailure':
    case 'Notification':
      return true
    case 'UserPromptSubmit':
      return false
    default:
      return null
  }
}

export async function forwardTaskEvent(home: string, id: string, session: TaskSession, agent: AgentKind, input: unknown): Promise<void> {
  const waiting = parseTaskEvent(agent, input)
  const endpoint = waiting === null ? null : await readCoreEndpoint(home)
  if (waiting === null || !endpoint) return
  const rpc = await connectRpc(coreUrl(endpoint))
  try {
    await rpc.call('tasks.event', { id, session, waiting })
  } finally {
    rpc.close()
  }
}
