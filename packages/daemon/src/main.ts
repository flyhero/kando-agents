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
import { createPtyHost } from './pty-host'

const paths = kandoPaths()
await mkdir(paths.home, { recursive: true, mode: 0o700 })
await claimEndpoint(paths.daemonSocket)

const clients = new Set<net.Socket>()
const host = createPtyHost((event) => {
  const line = `${JSON.stringify(event)}\n`
  clients.forEach((client) => client.write(line))
})

function dispatch<M extends DaemonMethod>(method: M, raw: unknown): DaemonResult<M> {
  return host.handlers[method](daemonSchemas[method].params.parse(raw))
}

function handleLine(socket: net.Socket, line: string): void {
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
    reply({ result: dispatch(method, params) })
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) })
  }
}

const server = net.createServer((socket) => {
  clients.add(socket)
  socket.on('data', createLineDecoder((line) => handleLine(socket, line)))
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
  host.killAll()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
