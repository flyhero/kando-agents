import { describe, expect, it } from 'vitest'
import { BrowserHostEndpoint, BrowserHostInbound, browserHostSchemas, browserHostUrl } from './browser-host-protocol'

describe('browser host protocol', () => {
  it('reads the host file and builds the socket URL from it', () => {
    const endpoint = BrowserHostEndpoint.parse({ port: 51234, token: 'a b', pid: 7, protocolVersion: 2 })
    expect(browserHostUrl(endpoint)).toBe('ws://127.0.0.1:51234/?token=a%20b')
  })

  it('tells an error from a result and an event from both', () => {
    expect(BrowserHostInbound.parse({ id: 1, error: { reason: 'browser-tab-not-found', message: 'gone' } })).toMatchObject({ error: { reason: 'browser-tab-not-found' } })
    expect(BrowserHostInbound.parse({ id: 2, result: { ok: true } })).toEqual({ id: 2, result: { ok: true } })
    expect(BrowserHostInbound.parse({ event: 'status', status: { state: 'starting', running: true } })).toMatchObject({ event: 'status' })
  })

  it('takes a viewport on open and navigate, within what a page can be laid out at', () => {
    const tabId = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
    expect(browserHostSchemas['tabs.open'].params.safeParse({ viewport: { width: 390, height: 844 } }).success).toBe(true)
    expect(browserHostSchemas.navigate.params.safeParse({ tabId, to: { url: 'https://example.com' }, viewport: null }).success).toBe(true)
    expect(browserHostSchemas.viewport.params.safeParse({ tabId, viewport: { width: 100, height: 844 } }).success).toBe(false)
  })

  it('checks action parameters against the shared shapes', () => {
    expect(browserHostSchemas.click.params.safeParse({ tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', ref: 'e12' }).success).toBe(true)
    expect(browserHostSchemas.click.params.safeParse({ tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', ref: 'f1e12' }).success).toBe(true)
    expect(browserHostSchemas.click.params.safeParse({ tabId: '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e', ref: '12' }).success).toBe(false)
  })
})
