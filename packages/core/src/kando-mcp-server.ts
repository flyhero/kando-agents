import type { McpServer } from './agent-command'
import { cliCommand } from './cli-command'

// The task is fixed at launch, so the agent can only ever propose for this one.
export function kandoMcpServer(taskId: string, home: string): McpServer {
  const [command, ...args] = cliCommand('mcp', '--task', taskId, '--home', home)
  if (!command) throw new Error('empty CLI command')
  return { command, args }
}
