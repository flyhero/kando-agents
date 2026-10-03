import { parseArgs } from 'node:util'
import { RpcError } from '@kando/protocol'
import { serveMcp } from './mcp-server'

// What agents run, never people: Kando configures it when it starts an agent.
const USAGE = `kando mcp [--conversation <id>] [--home dir]

  agent 用的 MCP 服务：展示 HTML 预览；带 --conversation 时还有浏览器工具
`

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      conversation: { type: 'string' }
    }
  })
  if (positionals[0] !== 'mcp') {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  // Speaks MCP on stdout, so nothing else may print there.
  await serveMcp(values.home, values.conversation)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const reason = error instanceof RpcError && error.reason ? ` (${error.reason})` : ''
  console.error(`kando: ${error instanceof Error ? error.message : String(error)}${reason}`)
  process.exitCode = 1
})
