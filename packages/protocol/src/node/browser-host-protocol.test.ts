import { describe, expect, it } from 'vitest'
import { BrowserHostInbound, BrowserHostListening, browserHostSchemas, browserHostUrl } from './browser-host-protocol'

describe('browser host protocol', () => {
  it('reads the listening line and builds the socket URL from it', () => {
    const line = BrowserHostListening.parse({ event: 'listening', port: 51234, token: 'a b', pid: 7, protocolVersion: 1 })
    expect(browserHostUrl(line)).toBe('ws://127.0.0.1:51234/?token=a%20b')
  })

  it('tells an error from a result and an event from both', () => {
    expect(BrowserHostInbound.parse({ id: 1, error: { reason: 'browser-tab-not-found', message: 'gone' } })).toMatchObject({ error: { reason: 'browser-tab-not-found' } })
    expect(BrowserHostInbound.parse({ id: 2, result: { ok: true } })).toEqual({ id: 2, result: { ok: true } })
    expect(BrowserHostInbound.parse({ event: 'status', status: { state: 'installing', percent: 40, running: true } })).toMatchObject({ event: 'status' })
    expect(BrowserHostInbound.parse({ event: 'frame', tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', seq: 3, width: 640, height: 400, data: 'AAAA' })).toMatchObject({ event: 'frame', seq: 3 })
  })

  it('checks action parameters against the shared shapes', () => {
    expect(browserHostSchemas.click.params.safeParse({ tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', ref: 'e12' }).success).toBe(true)
    expect(browserHostSchemas.click.params.safeParse({ tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', ref: '12' }).success).toBe(false)
  })
})
