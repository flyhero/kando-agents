import net from 'node:net'
import {
  DaemonInbound,
  createLineDecoder,
  daemonSchemas,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonParams,
  type DaemonResult
} from '@kando/protocol/node'
import { Rejection } from './rejection'

export type SessionHost = {
  request<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>
  onEvent(listener: (event: DaemonEvent) => void): () => void
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const RECONNECT_DELAY_MS = 1000

// Keeps reconnecting forever: the daemon outlives core, so core may start first.
export class DaemonClient implements SessionHost {
  private socket: net.Socket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: DaemonEvent) => void>()
  private readonly connectListeners = new Set<() => void>()
  private stopped = false
  private everConnected = false
  private warned = false

  constructor(private readonly socketPath: string) {}

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.socket?.destroy()
  }

  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onConnect(listener: () => void): () => void {
    this.connectListeners.add(listener)
    return () => this.connectListeners.delete(listener)
  }

  async request<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>> {
    const socket = this.socket
    if (!socket) {
      throw new Rejection('daemon-unavailable', 'PTY daemon is not running (pnpm dev:daemon)')
    }
    const id = this.nextId++
    const raw = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    return daemonSchemas[method].result.parse(raw)
  }

  private connect(): void {
    const socket = net.connect(this.socketPath)
    socket.on('connect', () => {
      this.socket = socket
      this.warned = false
      console.log(`[kando-core] ${this.everConnected ? 're' : ''}connected to daemon`)
      this.everConnected = true
      this.connectListeners.forEach((listener) => listener())
    })
    socket.on('data', createLineDecoder((line) => this.receive(line)))
    socket.on('error', () => {
      if (!this.warned) {
        console.log(`[kando-core] waiting for daemon at ${this.socketPath}`)
        this.warned = true
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
      }
      this.pending.forEach((p) => p.reject(new Rejection('daemon-unavailable', 'daemon disconnected')))
      this.pending.clear()
      if (!this.stopped) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS).unref()
      }
    })
  }

  private receive(line: string): void {
    let parsed
    try {
      parsed = DaemonInbound.safeParse(JSON.parse(line))
    } catch {
      return
    }
    if (!parsed.success) {
      return
    }
    const message = parsed.data
    if ('event' in message) {
      this.eventListeners.forEach((listener) => listener(message))
      return
    }
    const pending = this.pending.get(message.id)
    this.pending.delete(message.id)
    if ('error' in message) {
      pending?.reject(new Rejection(message.error))
    } else {
      pending?.resolve(message.result)
    }
  }
}
