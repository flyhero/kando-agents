import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { BrowserHostInbound, BrowserHostListening, browserHostUrl, type BrowserHostEvent, type BrowserHostMethod, type BrowserHostParams, type BrowserHostResult } from '@kando/protocol/node'
import { createLineDecoder } from '@kando/protocol/node'

// Runs the real host with a real Chromium, so only on request: KANDO_BROWSER_TESTS names the home
// to use (its Chromium download is kept between runs), or is 1 for one under the temp directory.
const home = process.env.KANDO_BROWSER_TESTS === '1' ? path.join(os.tmpdir(), 'kando-browser-tests') : process.env.KANDO_BROWSER_TESTS

class HostClient {
  private next = 1
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  readonly events: BrowserHostEvent[] = []

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const inbound = BrowserHostInbound.parse(JSON.parse(data.toString()))
      if ('event' in inbound) {
        this.events.push(inbound)
        return
      }
      const waiter = this.waiting.get(inbound.id)
      this.waiting.delete(inbound.id)
      if ('error' in inbound) waiter?.reject(new Error(`${inbound.error.reason}: ${inbound.error.message}`))
      else waiter?.resolve(inbound.result)
    })
  }

  call<M extends BrowserHostMethod>(method: M, params: BrowserHostParams<M>): Promise<BrowserHostResult<M>> {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve: (value) => resolve(value as BrowserHostResult<M>), reject }))
  }

  async waitFor<E extends BrowserHostEvent['event']>(event: E, test: (found: Extract<BrowserHostEvent, { event: E }>) => boolean = () => true, timeoutMs = 30_000): Promise<Extract<BrowserHostEvent, { event: E }>> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = this.events.find((candidate): candidate is Extract<BrowserHostEvent, { event: E }> => candidate.event === event && test(candidate as Extract<BrowserHostEvent, { event: E }>))
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`no ${event} event`)
  }
}

describe.skipIf(!home)('browser host', () => {
  let child: ChildProcess
  let client: HostClient
  let local: Server
  let localUrl: string

  beforeAll(async () => {
    if (!home) return
    await mkdir(home, { recursive: true })
    const main = fileURLToPath(new URL('./main.ts', import.meta.url))
    const loader = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url))
    child = spawn(process.execPath, ['--import', loader, main, '--home', home], { stdio: ['ignore', 'pipe', 'inherit'] })
    const listening = await new Promise<BrowserHostListening>((resolve) => {
      child.stdout?.on('data', createLineDecoder((line) => resolve(BrowserHostListening.parse(JSON.parse(line)))))
    })
    const socket = new WebSocket(browserHostUrl(listening))
    await new Promise((resolve) => socket.once('open', resolve))
    client = new HostClient(socket)
    local = createServer((request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(request.url === '/next' ? '<title>Next</title><h1>Arrived</h1>' : '<title>Local</title><button id="go" onclick="location.href=\'/next\'">Go next</button><input aria-label="Name">')
    })
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve))
    const address = local.address()
    localUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
    const status = await client.call('status', {})
    if (status.state !== 'ready') {
      await client.call('install', {})
      await client.waitFor('status', (event) => event.status.state === 'ready' || event.status.state === 'error', 10 * 60_000)
    }
  }, 11 * 60_000)

  afterAll(async () => {
    await Promise.race([client?.call('shutdown', {}).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))])
    child?.kill()
    local?.close()
  }, 15_000)

  it('opens a local page without asking, acts by ref and screenshots it', async () => {
    const conversationId = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
    const opened = await client.call('tabs.open', { conversationId, url: localUrl })
    expect(opened.outcome).toBe('done')
    expect(opened.tab.title).toBe('Local')
    expect(opened.snapshot).toMatch(/button "Go next" \[ref=e\d+\]/)
    const ref = /button "Go next" \[ref=(e\d+)\]/.exec(opened.snapshot ?? '')?.[1] ?? ''
    const input = /textbox "Name" \[ref=(e\d+)\]/.exec(opened.snapshot ?? '')?.[1] ?? ''
    const typed = await client.call('type', { tabId: opened.tab.id, ref: input, text: 'kando' })
    expect(typed.snapshot).toContain('kando')
    const clicked = await client.call('click', { tabId: opened.tab.id, ref })
    expect(clicked.tab.url).toBe(`${localUrl}/next`)
    expect(clicked.snapshot).toContain('Arrived')
    const shot = await client.call('screenshot', { tabId: opened.tab.id })
    expect(Buffer.from(shot.jpeg, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    await expect(client.call('click', { tabId: opened.tab.id, ref: 'e999' })).rejects.toThrow('browser-ref-not-found')
    expect(client.events.some((event) => event.event === 'hostCheck')).toBe(false)
  }, 60_000)

  it('holds a navigation to a site outside local development until core answers', async () => {
    const conversationId = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
    const opened = await client.call('tabs.open', { conversationId })
    const navigation = client.call('navigate', { tabId: opened.tab.id, to: { url: 'https://example.com' } })
    const check = await client.waitFor('hostCheck', (event) => event.host === 'example.com')
    expect(check.tabId).toBe(opened.tab.id)
    await client.call('host.resolve', { checkId: check.checkId, allow: false })
    expect((await navigation).outcome).toBe('denied')
  }, 60_000)

  it('streams frames of a tab and takes input on it', async () => {
    const conversationId = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
    const opened = await client.call('tabs.open', { conversationId, url: localUrl })
    await client.call('screencast.start', { tabId: opened.tab.id, maxWidth: 640, maxHeight: 400 })
    const frame = await client.waitFor('frame', (event) => event.tabId === opened.tab.id)
    expect(frame.width).toBeLessThanOrEqual(640)
    expect(Buffer.from(frame.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const box = /button "Go next" \[ref=(e\d+)\]/.exec(opened.snapshot ?? '')
    expect(box).not.toBeNull()
    await client.call('input', { tabId: opened.tab.id, event: { type: 'mouse', action: 'moved', x: 20, y: 20, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 } })
    await client.call('input', { tabId: opened.tab.id, event: { type: 'mouse', action: 'pressed', x: 20, y: 20, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } })
    await client.call('input', { tabId: opened.tab.id, event: { type: 'mouse', action: 'released', x: 20, y: 20, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 } })
    await client.waitFor('tabs', (event) => event.tabs.some((tab) => tab.id === opened.tab.id && tab.url.endsWith('/next')))
    await client.call('screencast.stop', { tabId: opened.tab.id })
    await client.call('tabs.closeAll', { conversationId })
    expect((await client.call('tabs.list', {})).tabs).toEqual([])
  }, 60_000)
})
