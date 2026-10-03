import type { McpServer } from './agent-command'
import { cliCommand } from './cli-command'

// The tools every conversation has (showing a file the agent wrote, the browser), acting for this
// one conversation, whose tabs are the only ones it reaches.
export function kandoChatMcpServer(home: string, conversationId: string): McpServer {
  const [command, ...args] = cliCommand('mcp', '--home', home, '--conversation', conversationId)
  if (!command) throw new Error('empty CLI command')
  return { command, args }
}
