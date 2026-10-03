import { parseArgs } from 'node:util'
import { AgentKind, RpcError, TaskSession } from '@kando/protocol'
import { serveMcp } from './mcp-server'
import { forwardConversationEvent } from './conversation-event'
import { forwardTaskEvent } from './task-event'
import { forwardOriginalCodexNotify } from './codex-notify'

// What agents run, never people: Kando configures each of these when it starts an agent.
const USAGE = `kando <command>

  mcp [--task <id>] [--conversation <id>] [--home dir]
                                         agent 用的 MCP 服务：展示 HTML 预览；带 --conversation 时
                                         还有浏览器工具，带 --task 时还有细化用的工具
  task-event / conversation-event        agent 的 hooks 回报回合结束
`

// Codex passes the event as JSON in argv; Claude sends it on stdin.
async function eventPayload(payload: string | undefined): Promise<string> {
  return payload ?? await new Promise<string>((resolve) => {
    let chunks = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => { chunks += chunk })
    process.stdin.on('end', () => resolve(chunks))
  })
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'task-event') {
    const [, home, id, sessionName, agentName, payload] = argv
    const agent = AgentKind.parse(agentName)
    try {
      await forwardTaskEvent(home ?? '', id ?? '', TaskSession.parse(sessionName), agent, JSON.parse(await eventPayload(payload)))
    } catch {
      // A failed callback must never fail the agent's own turn.
    } finally {
      if (agent === 'codex' && payload) forwardOriginalCodexNotify(payload)
    }
    return
  }
  if (argv[0] === 'conversation-event') {
    const [, home, id, stageId, agentName, payload] = argv
    const agent = AgentKind.parse(agentName)
    try {
      await forwardConversationEvent(home ?? '', id ?? '', stageId ?? '', agent, JSON.parse(await eventPayload(payload)))
    } catch {
      // A failed callback must never fail the agent's own turn.
    } finally {
      if (agent === 'codex' && payload) forwardOriginalCodexNotify(payload)
    }
    return
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
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
  await serveMcp(values.task, values.home, values.conversation)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const reason = error instanceof RpcError && error.reason ? ` (${error.reason})` : ''
  console.error(`kando: ${error instanceof Error ? error.message : String(error)}${reason}`)
  process.exitCode = 1
})
