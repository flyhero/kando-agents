import { parseArgs } from 'node:util'
import { RpcError } from '@kando/protocol'
import { serveMcp } from './mcp-server'
import { writePrivateJson } from './private-file'

// Kando's MCP server, a process of its own that an agent starts over stdio: core configures it
// for every chat (see mcpCommand), and it reaches core over RPC like any other client.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: 'string' },
    conversation: { type: 'string' },
    'plan-only': { type: 'boolean' },
    'ready-file': { type: 'string' }
  }
})

// Speaks MCP on stdout, so nothing else may print there.
const readyFile = values['ready-file']
serveMcp(values.home, values.conversation, values['plan-only'], readyFile ? () => writePrivateJson(readyFile, { ready: true }) : undefined).catch((error: unknown) => {
  const reason = error instanceof RpcError && error.reason ? ` (${error.reason})` : ''
  console.error(`kando mcp: ${error instanceof Error ? error.message : String(error)}${reason}`)
  process.exitCode = 1
})
