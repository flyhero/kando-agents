import { describe, expect, it, vi } from 'vitest'
import { BROWSER_HOST_DECISION_WAIT_MS } from '@kando/protocol'
import { gatedHost, HostGate } from './host-gate'
import type { TabRegistry } from './tabs'

function request(url: string, navigation = true, parent: unknown = null) {
  return { url: () => url, isNavigationRequest: () => navigation, frame: () => ({ parentFrame: () => parent }) }
}

describe('gatedHost', () => {
  it('names the host of a top-level navigation to a site outside local development', () => {
    expect(gatedHost(request('https://example.com/a'))).toBe('example.com')
    expect(gatedHost(request('http://app.example.test:3000/'))).toBeNull()
    expect(gatedHost(request('http://localhost:5173/'))).toBeNull()
  })

  it('lets subresources, frames and non-web schemes through', () => {
    expect(gatedHost(request('https://cdn.example.com/x.js', false))).toBeNull()
    expect(gatedHost(request('https://example.com/', true, {}))).toBeNull()
    expect(gatedHost(request('data:text/html,hi'))).toBeNull()
    expect(gatedHost(request('about:blank'))).toBeNull()
    expect(gatedHost(request('not a url'))).toBeNull()
  })
})

describe('HostGate', () => {
  it('gives up on a check nobody answers in time, and reports why the tab was stopped', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const gate = new HostGate({} as TabRegistry, (check) => asked.push(check.checkId))
    const outcome = gate['check']({ checkId: 'c1', tabId: 't1', conversationId: 'conv', host: 'example.com', url: 'https://example.com/' })
    expect(asked).toEqual(['c1'])
    await vi.advanceTimersByTimeAsync(BROWSER_HOST_DECISION_WAIT_MS)
    expect(await outcome).toBe('awaiting-host')
    vi.useRealTimers()
  })

  it('resolves a check as core answers it, once', async () => {
    const gate = new HostGate({} as TabRegistry, () => {})
    const outcome = gate['check']({ checkId: 'c2', tabId: 't1', conversationId: 'conv', host: 'example.com', url: 'https://example.com/' })
    gate.resolve('c2', false)
    gate.resolve('c2', true)
    expect(await outcome).toBe('denied')
    expect(gate.takeOutcome('t1')).toBe('done')
  })
})
