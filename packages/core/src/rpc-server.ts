import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { ZodError } from 'zod'
import {
  RPC_ERROR,
  RpcRequest,
  isRpcMethod,
  rpcSchemas,
  type RpcMethod,
  type RpcNotificationName,
  type RpcNotificationParams,
  type RpcParsedParams,
  type RpcResult
} from '@kando/protocol'
import { Rejection } from './rejection'

export type Connection = {
  readonly attached: Set<string>
  notify<N extends RpcNotificationName>(name: N, params: RpcNotificationParams<N>): void
  // For state that belongs to this client alone, like a sign-in waiting on its answers.
  onClose(listener: () => void): () => void
}

export type RpcHandlers = {
  [M in RpcMethod]: (
    params: RpcParsedParams<M>,
    connection: Connection
  ) => RpcResult<M> | Promise<RpcResult<M>>
}

export type RpcServer = {
  port: number
  connections: ReadonlySet<Connection>
  broadcast<N extends RpcNotificationName>(name: N, params: RpcNotificationParams<N>): void
  close(): Promise<void>
}

function tokenMatches(url: string | undefined, token: string): boolean {
  const given = new URL(url ?? '/', 'ws://localhost').searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function errorFrame(id: number | null, code: number, message: string, reason?: string): string {
  const data = reason ? { reason } : undefined
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })
}

export function startRpcServer(options: {
  port: number
  token: string
  handlers: RpcHandlers
}): Promise<RpcServer> {
  const { handlers, token } = options
  const connections = new Set<Connection>()

  function dispatch<M extends RpcMethod>(method: M, raw: unknown, connection: Connection) {
    return handlers[method](rpcSchemas[method].params.parse(raw ?? {}), connection)
  }

  async function handleFrame(text: string, connection: Connection): Promise<string> {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return errorFrame(null, RPC_ERROR.parseError, 'invalid JSON')
    }
    const request = RpcRequest.safeParse(json)
    if (!request.success) {
      return errorFrame(null, RPC_ERROR.invalidRequest, 'invalid request')
    }
    const { id, method, params } = request.data
    if (!isRpcMethod(method)) {
      return errorFrame(id, RPC_ERROR.methodNotFound, `unknown method ${method}`)
    }
    try {
      const result = await dispatch(method, params, connection)
      return JSON.stringify({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof ZodError) {
        return errorFrame(id, RPC_ERROR.invalidParams, error.message, 'invalid-params')
      }
      if (error instanceof Rejection) {
        return errorFrame(id, RPC_ERROR.rejected, error.message, error.reason)
      }
      console.error(`[kando-core] ${method} failed`, error)
      return errorFrame(id, RPC_ERROR.internal, 'internal error')
    }
  }

  // Loopback only, and every client must present the token from core.json:
  // any web page can open ws://127.0.0.1, so the port alone is not a boundary.
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => tokenMatches(req.url, token)
  })

  wss.on('connection', (socket) => {
    const send = (frame: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame)
      }
    }
    const closeListeners = new Set<() => void>()
    const connection: Connection = {
      attached: new Set(),
      notify: (name, params) => send(JSON.stringify({ jsonrpc: '2.0', method: name, params })),
      onClose: (listener) => {
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      }
    }
    connections.add(connection)
    socket.on('message', (data) => {
      void handleFrame(data.toString(), connection).then(send)
    })
    socket.on('close', () => {
      connections.delete(connection)
      closeListeners.forEach((listener) => listener())
    })
  })

  return new Promise((resolve, reject) => {
    wss.once('error', reject)
    wss.once('listening', () => {
      const address: AddressInfo | string | null = wss.address()
      resolve({
        port: address !== null && typeof address === 'object' ? address.port : options.port,
        connections,
        broadcast: (name, params) => connections.forEach((c) => c.notify(name, params)),
        close: () =>
          new Promise((done) => {
            wss.clients.forEach((client) => client.terminate())
            wss.close(() => done())
          })
      })
    })
  })
}
