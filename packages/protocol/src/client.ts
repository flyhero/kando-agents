import {
  PROTOCOL_VERSION,
  RpcFrame,
  isRpcNotificationName,
  rpcNotificationSchemas,
  rpcSchemas,
  type RpcMethod,
  type RpcNotificationName,
  type RpcNotificationParams,
  type RpcParams,
  type RpcResult
} from './rpc'

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly reason: string | null
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type Listener = (params: unknown) => void

export type RpcClient = {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  on<N extends RpcNotificationName>(
    name: N,
    listener: (params: RpcNotificationParams<N>) => void
  ): () => void
  receive(frame: string): void
  failAll(error: Error): void
}

// Transport-agnostic so browser, Electron renderer and Node CLI share one client.
export function createRpcClient(send: (frame: string) => void): RpcClient {
  let nextId = 1
  const pending = new Map<number, Pending>()
  const listeners = new Map<RpcNotificationName, Set<Listener>>()

  return {
    async call(method, params) {
      const id = nextId++
      const raw = await new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
      // Validating results keeps a newer/older core from silently corrupting UI state.
      return rpcSchemas[method].result.parse(raw)
    },
    on(name, listener) {
      const schema = rpcNotificationSchemas[name]
      const wrapped: Listener = (params) => listener(schema.parse(params))
      const set = listeners.get(name) ?? new Set()
      set.add(wrapped)
      listeners.set(name, set)
      return () => set.delete(wrapped)
    },
    receive(text) {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return
      }
      const frame = RpcFrame.safeParse(json)
      if (!frame.success) {
        return
      }
      const msg = frame.data
      if ('result' in msg) {
        pending.get(msg.id)?.resolve(msg.result)
        pending.delete(msg.id)
      } else if ('error' in msg) {
        if (msg.id === null) {
          return
        }
        const { message, code, data } = msg.error
        pending.get(msg.id)?.reject(new RpcError(message, code, data?.reason ?? null))
        pending.delete(msg.id)
      } else if (!('id' in msg) && isRpcNotificationName(msg.method)) {
        // Unknown notifications are dropped so an older client survives a newer core.
        listeners.get(msg.method)?.forEach((listener) => listener(msg.params))
      }
    },
    failAll(error) {
      pending.forEach((p) => p.reject(error))
      pending.clear()
    }
  }
}

export type RpcConnection = RpcClient & {
  close(): void
  closed: Promise<void>
}

export function connectRpc(url: string): Promise<RpcConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const client = createRpcClient((frame) => socket.send(frame))
    let markClosed: () => void = () => {}
    const closed = new Promise<void>((r) => (markClosed = r))
    let opened = false

    socket.onmessage = (event) => client.receive(String(event.data))
    socket.onclose = () => {
      client.failAll(new Error('connection closed'))
      markClosed()
      if (!opened) {
        reject(new Error(`cannot connect to Kando core`))
      }
    }
    socket.onopen = async () => {
      opened = true
      const connection: RpcConnection = { ...client, close: () => socket.close(), closed }
      try {
        const hello = await client.call('system.hello', { protocolVersion: PROTOCOL_VERSION })
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `protocol mismatch: client ${PROTOCOL_VERSION}, core ${hello.protocolVersion}`
          )
        }
        resolve(connection)
      } catch (error) {
        socket.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
}
