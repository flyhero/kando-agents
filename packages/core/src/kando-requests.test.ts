import { describe, expect, it } from 'vitest'
import { ChatItems } from './chat-items'
import { KandoRequests } from './kando-requests'

describe('KandoRequests', () => {
  it('shows a question as an approval, answers it, and cancels what is left when the agent goes', () => {
    const items = new ChatItems('stage-1')
    const requests = new KandoRequests(items)
    requests.apply({ dir: 'ask', at: 1, requestId: 'kando:browser-host:1', ask: { kind: 'browser-host', host: 'example.com', url: 'https://example.com/' } })
    requests.apply({ dir: 'ask', at: 2, requestId: 'kando:browser-host:2', ask: { kind: 'browser-host', host: 'other.com', url: 'https://other.com/' } })
    expect(requests.pending).toBe(2)
    expect(items.list()).toMatchObject([
      { kind: 'approval', requestId: 'kando:browser-host:1', tool: 'browser_host', title: 'example.com', detail: 'https://example.com/', decisions: ['allow', 'allowForSession', 'deny'], resolution: null },
      { kind: 'approval', requestId: 'kando:browser-host:2' }
    ])
    requests.apply({ dir: 'answer', at: 3, requestId: 'kando:browser-host:1', resolution: 'allowedForSession' })
    expect(requests.pending).toBe(1)
    requests.cancelAll(4)
    expect(requests.pending).toBe(0)
    expect(items.list().map((item) => item.kind === 'approval' && item.resolution)).toEqual(['allowedForSession', 'cancelled'])
  })
})
