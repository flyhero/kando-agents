import type { McpServer } from './agent-command'
import { cliCommand } from './cli-command'

// The task is fixed at launch, so the agent can only ever propose for this one.
export function kandoMcpServer(taskId: string, home: string): McpServer {
  const [command, ...args] = cliCommand('mcp', '--task', taskId, '--home', home)
  if (!command) throw new Error('empty CLI command')
  return { command, args }
}

// For a chat: the tools every conversation has (showing a file the agent wrote, the browser),
// acting for this one conversation, whose tabs are the only ones it reaches.
export function kandoChatMcpServer(home: string, conversationId: string): McpServer {
  const [command, ...args] = cliCommand('mcp', '--home', home, '--conversation', conversationId)
  if (!command) throw new Error('empty CLI command')
  return { command, args }
}
