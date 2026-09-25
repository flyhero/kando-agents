import { rpcNotificationSchemas, type RpcNotificationName, type RpcNotificationParams } from '@kando/protocol'
import type { FlowOwner } from './source-login-flow'

// A client connection for tests: records what core sends it, and can be closed.
export type FakeConnection = FlowOwner & {
  notes: { name: RpcNotificationName; params: unknown }[]
  close(): void
  // The latest notification of one kind, read back through its schema.
  last<N extends RpcNotificationName>(name: N): RpcNotificationParams<N> | undefined
}

export function fakeConnection(): FakeConnection {
  const notes: { name: RpcNotificationName; params: unknown }[] = []
  const listeners = new Set<() => void>()
  return {
    notes,
    notify: (name, params) => {
      notes.push({ name, params })
    },
    onClose: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => listeners.forEach((listener) => listener()),
    last: (name) => {
      const found = notes.findLast((note) => note.name === name)
      return found ? rpcNotificationSchemas[name].parse(found.params) : undefined
    }
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// Waits for `read` to produce something. Bounded by time, not turns of the event loop: file
// writes finish on the thread pool, which a busy test run can hold up for a while.
export async function until<T>(read: () => T | undefined, timeoutMs: number = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error('condition never held')
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
