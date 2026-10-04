import { chmod, mkdir } from 'node:fs/promises'
import net from 'node:net'
import {
  DaemonRequest,
  createLineDecoder,
  daemonSchemas,
  isDaemonMethod,
  kandoPaths,
  type DaemonMethod,
  type DaemonResult
} from '@kando/protocol/node'
import { claimEndpoint } from './endpoint-claim'
import { createSessionHost } from './session-host'
import { AwakeService } from './awake-service'

// Packaged, the Electron binary runs the daemon as plain Node. Sessions inherit this process's
// environment, and the flag must not leak into them: it would turn any Electron app a shell or
// an agent starts into a Node interpreter.
delete process.env.ELECTRON_RUN_AS_NODE

const paths = kandoPaths()
await mkdir(paths.home, { recursive: true, mode: 0o700 })
await claimEndpoint(paths.daemonSocket)

const clients = new Set<net.Socket>()
const awake = new AwakeService()
const host = createSessionHost((event) => {
  const line = `${JSON.stringify(event)}\n`
  clients.forEach((client) => client.write(line))
}, awake)

async function dispatch<M extends DaemonMethod>(method: M, raw: unknown): Promise<DaemonResult<M>> {
  const result = await host.handlers[method](daemonSchemas[method].params.parse(raw))
  return daemonSchemas[method].result.parse(result)
}

async function handleLine(socket: net.Socket, line: string): Promise<void> {
  let request
  try {
    request = DaemonRequest.parse(JSON.parse(line))
  } catch {
    return
  }
  const { id, method, params } = request
  const reply = (body: object) => socket.write(`${JSON.stringify({ id, ...body })}\n`)
  if (!isDaemonMethod(method)) {
    reply({ error: 'unknown-method' })
    return
  }
  try {
    reply({ result: await dispatch(method, params) })
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) })
  }
}

const server = net.createServer((socket) => {
  clients.add(socket)
  socket.on('data', createLineDecoder((line) => { void handleLine(socket, line) }))
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

server.listen(paths.daemonSocket, async () => {
  if (process.platform !== 'win32') {
    await chmod(paths.daemonSocket, 0o600)
  }
  console.log(`[kando-daemon] listening on ${paths.daemonSocket}`)
})

function shutdown(): void {
  awake.dispose()
  host.killAll()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
