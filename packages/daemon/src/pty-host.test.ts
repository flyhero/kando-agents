import { describe, expect, it, vi } from 'vitest'
import type { DaemonEvent } from '@kando/protocol/node'

const callbacks = vi.hoisted(() => ({
  data: (_text: string) => {},
  exit: (_event: { exitCode: number }) => {}
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (handler: (text: string) => void) => { callbacks.data = handler },
    onExit: (handler: (event: { exitCode: number }) => void) => { callbacks.exit = handler },
    write: () => {}, resize: () => {}, kill: () => {}
  })
}))

import { createPtyHost } from './pty-host'

describe('PTY output offsets', () => {
  it('reports monotonic offsets and the bounded attach range', () => {
    const events: DaemonEvent[] = []
    const host = createPtyHost((event) => events.push(event))
    const { sessionId } = host.handlers.spawn({ command: 'agent', args: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 })
    callbacks.data('abc')
    callbacks.data('def')
    expect(events).toEqual([
      { event: 'data', sessionId, offset: 0, data: 'abc' },
      { event: 'data', sessionId, offset: 3, data: 'def' }
    ])
    const large = 'x'.repeat(600 * 1024)
    callbacks.data(large)
    const attached = host.handlers.attach({ sessionId })
    expect(attached.endOffset).toBe(6 + large.length)
    expect(attached.buffer.length).toBe(512 * 1024)
    expect(attached.bufferStart).toBe(attached.endOffset - attached.buffer.length)
    callbacks.exit({ exitCode: 7 })
    expect(host.handlers.attach({ sessionId }).exitCode).toBe(7)
  })
})
