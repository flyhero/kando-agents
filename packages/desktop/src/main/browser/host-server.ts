import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { ZodError } from 'zod'
import {
  BrowserHostRequest,
  browserHostSchemas,
  isBrowserHostMethod,
  type BrowserHostEvent,
  type BrowserHostMethod,
  type BrowserHostParsedParams,
  type BrowserHostResult
} from '@kando/protocol/node'
import { HostError } from './host-error'

export type HostHandlers = {
  [M in BrowserHostMethod]: (params: BrowserHostParsedParams<M>) => BrowserHostResult<M> | Promise<BrowserHostResult<M>>
}

export type HostServer = {
  port: number
  token: string
  emit(event: BrowserHostEvent): void
  close(): Promise<void>
}

function tokenMatches(url: string | undefined, token: string): boolean {
  const given = new URL(url ?? '/', 'ws://localhost').searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function errorLine(id: number, reason: string, message: string): string {
  return JSON.stringify({ id, error: { reason, message } })
}

// Loopback only, with a token core learns from the host file. The home directory
// is owner-only, but any page can open ws://127.0.0.1, so the port alone is not a boundary.
export function startHostServer(handlers: HostHandlers): Promise<HostServer> {
  const token = randomBytes(24).toString('hex')
  const sockets = new Set<WebSocket>()

  async function handle(text: string): Promise<string | null> {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    const request = BrowserHostRequest.safeParse(json)
    if (!request.success) return null
    const { id, method, params } = request.data
    if (!isBrowserHostMethod(method)) return errorLine(id, 'unknown-method', `unknown method ${method}`)
    try {
      const result = await dispatch(method, params)
      return JSON.stringify({ id, result })
    } catch (error) {
      if (error instanceof ZodError) return errorLine(id, 'invalid-params', error.message)
      if (error instanceof HostError) return errorLine(id, error.reason, error.message)
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[browser] ${method} failed: ${message}`)
      return errorLine(id, 'browser-failed', message)
    }
  }

  function dispatch<M extends BrowserHostMethod>(method: M, raw: unknown) {
    return handlers[method](browserHostSchemas[method].params.parse(raw ?? {}))
  }

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      // A full-page screenshot can be large; frames never are.
      maxPayload: 32 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => tokenMatches(req.url, token)
    })
    wss.on('error', reject)
    wss.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('message', (data) => {
        void handle(data.toString()).then((reply) => {
          if (reply && socket.readyState === WebSocket.OPEN) socket.send(reply)
        })
      })
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => sockets.delete(socket))
    })
    wss.on('listening', () => {
      const address = wss.address()
      if (typeof address === 'string' || !address) {
        reject(new Error('browser host socket has no port'))
        return
      }
      const { port } = address satisfies AddressInfo
      resolve({
        port,
        token,
        emit: (event) => {
          const line = JSON.stringify(event)
          for (const socket of sockets) {
            if (socket.readyState === WebSocket.OPEN) socket.send(line)
          }
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.close()
            wss.close(() => done())
          })
      })
    })
  })
}
