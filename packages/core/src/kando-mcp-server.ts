import type { McpServer } from './agent-command'
import { mcpCommand } from './mcp-command'

// The tools every conversation has (showing a file the agent wrote, the browser), acting for this
// one conversation, whose tabs are the only ones it reaches.
export function kandoChatMcpServer(home: string, conversationId: string): McpServer {
  const [command, ...args] = mcpCommand('--home', home, '--conversation', conversationId)
  if (!command) throw new Error('empty MCP command')
  return { command, args }
}
