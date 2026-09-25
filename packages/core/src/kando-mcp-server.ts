import { fileURLToPath } from 'node:url'
import type { McpServer } from './agent-command'

// Dev layout: the CLI runs from source through this workspace's tsx. A packaged build
// will point at the installed `kando` binary instead. The shim is `tsx.cmd` on Windows.
export function kandoMcpServer(taskId: string, home: string): McpServer {
  const tsx = fileURLToPath(
    new URL(`../node_modules/.bin/${process.platform === 'win32' ? 'tsx.cmd' : 'tsx'}`, import.meta.url)
  )
  const cli = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
  // The task is fixed at launch, so the agent can only ever propose for this one.
  return { command: tsx, args: [cli, 'mcp', '--task', taskId, '--home', home] }
}
