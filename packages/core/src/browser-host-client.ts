import { WebSocket } from 'ws'
import {
  BrowserHostInbound,
  browserHostSchemas,
  browserHostUrl,
  type BrowserHostEvent,
  type BrowserHostListening,
  type BrowserHostMethod,
  type BrowserHostParams,
  type BrowserHostResult
} from '@kando/protocol/node'
import { Rejection } from './rejection'

// Core's side of the browser host's socket. No reconnecting: the socket going is the host going,
// and the service starts another when one is wanted again.
export type HostLink = {
  request<M extends BrowserHostMethod>(method: M, params: BrowserHostParams<M>): Promise<BrowserHostResult<M>>
  onEvent(listener: (event: BrowserHostEvent) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

export type HostConnect = (endpoint: BrowserHostListening) => Promise<HostLink>

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export function connectBrowserHost(endpoint: BrowserHostListening): Promise<HostLink> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(browserHostUrl(endpoint), { maxPayload: 32 * 1024 * 1024 })
    const pending = new Map<number, Pending>()
    const eventListeners = new Set<(event: BrowserHostEvent) => void>()
    const closeListeners = new Set<() => void>()
    let nextId = 1
    let open = false
    socket.on('message', (data) => {
      let parsed
      try {
        parsed = BrowserHostInbound.safeParse(JSON.parse(data.toString()))
      } catch {
        return
      }
      if (!parsed.success) return
      const message = parsed.data
      if ('event' in message) {
        eventListeners.forEach((listener) => listener(message))
        return
      }
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if ('error' in message) waiter?.reject(new Rejection(message.error.reason, message.error.message))
      else waiter?.resolve(message.result)
    })
    socket.on('error', (error) => {
      if (!open) reject(new Rejection('browser-unavailable', `browser host refused: ${error.message}`))
    })
    socket.on('close', () => {
      pending.forEach((waiter) => waiter.reject(new Rejection('browser-unavailable', '浏览器没有运行')))
      pending.clear()
      if (open) closeListeners.forEach((listener) => listener())
    })
    socket.on('open', () => {
      open = true
      resolve({
        async request(method, params) {
          if (socket.readyState !== WebSocket.OPEN) throw new Rejection('browser-unavailable', '浏览器没有运行')
          const id = nextId++
          const raw = await new Promise<unknown>((resolveRequest, rejectRequest) => {
            pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
            socket.send(JSON.stringify({ id, method, params }))
          })
          return browserHostSchemas[method].result.parse(raw)
        },
        onEvent: (listener) => {
          eventListeners.add(listener)
          return () => eventListeners.delete(listener)
        },
        onClose: (listener) => {
          closeListeners.add(listener)
          return () => closeListeners.delete(listener)
        },
        close: () => socket.close()
      })
    })
  })
}
