import { afterEach, expect, it, vi } from 'vitest'
import { localTime, timestampConsole } from './log-timestamps'

const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
afterEach(() => Object.assign(console, original))

it('writes local time to the millisecond', () => {
  expect(localTime(new Date(2026, 9, 9, 16, 3, 7, 5))).toBe('2026-10-09 16:03:07.005')
})

it('puts the time before every line core logs', () => {
  const error = vi.fn()
  const log = vi.fn()
  Object.assign(console, { error, log })
  timestampConsole(() => new Date(2026, 9, 9, 16, 13, 16, 512))
  console.error('[kando-core] browser host not reachable', 42)
  console.log('[kando-core] connected to daemon')
  expect(error).toHaveBeenCalledWith('2026-10-09 16:13:16.512', '[kando-core] browser host not reachable', 42)
  expect(log).toHaveBeenCalledWith('2026-10-09 16:13:16.512', '[kando-core] connected to daemon')
})
