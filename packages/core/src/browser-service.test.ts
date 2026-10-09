import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatDecision } from '@kando/protocol'
import { AttachmentStore } from './attachment-store'
import { BrowserService, type BrowserEvent } from './browser-service'
import { fakeBrowserHost } from './fake-browser-host'
import { fakeConnection, until } from './fake-connection'
import { Rejection } from './rejection'
import { writePrivateJson } from '@kando/protocol/node'

const CONV_A = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
const CONV_B = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'

describe('BrowserService', () => {
  let root: string
  let hostFile: string
  let host: ReturnType<typeof fakeBrowserHost>
  let events: BrowserEvent[]
  let asks: Array<{ conversationId: string; host: string; url: string; answer: (decision: ChatDecision) => void; drop: () => void }>
  let service: BrowserService
  let now: number

  // The service as main.ts makes it, over the fake host's link.
  const make = (ask: (conversationId: string, host: string, url: string) => Promise<ChatDecision>, onEvent: (event: BrowserEvent) => void = () => {}) =>
    new BrowserService({ browserHostFile: hostFile }, new AttachmentStore(path.join(root, 'attachments')), ask, onEvent, (endpoint) => host.connect(endpoint), () => now)

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-browser-'))
    mkdirSync(path.join(root, 'attachments'))
    mkdirSync(path.join(root, 'browser'))
    hostFile = path.join(root, 'browser', 'host.json')
    host = fakeBrowserHost()
    events = []
    asks = []
    now = 1_800_000_000_000
    // The app is up: it has written where its host listens.
    await writePrivateJson(hostFile, host.endpoint())
    service = make(
      (conversationId, hostName, url) => new Promise((resolve, reject) => asks.push({ conversationId, host: hostName, url, answer: resolve, drop: () => reject(new Error('gone')) })),
      (event) => events.push(event)
    )
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('connects to the app\'s host through the host file, and opens tabs for a conversation', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    expect(opened).toMatchObject({ outcome: 'done', tab: { conversationId: CONV_A, url: 'http://localhost:5173/', active: true, userDriving: false, agentActing: false } })
    expect(opened.snapshot).toContain('[ref=e1]')
    expect(service.tabsOf(CONV_A)).toHaveLength(1)
    expect(service.tabsOf(CONV_B)).toEqual([])
    expect(events.findLast((event) => event.type === 'status')).toMatchObject({ status: { state: 'ready', running: true } })
    expect(events.filter((event) => event.type === 'tabs' && event.conversationId === CONV_A).length).toBeGreaterThan(0)
  })

  it('keeps one conversation out of another\'s tabs', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    await expect(service.snapshot(CONV_B, opened.tab.id)).rejects.toMatchObject({ reason: 'browser-tab-not-found' })
    await expect(service.click(CONV_A, opened.tab.id, { ref: 'e1' })).resolves.toMatchObject({ snapshot: 'clicked e1' })
  })

  it('asks the user about a site once per answer: once for allow, for the conversation for allowForSession', async () => {
    const opened = await service.open(CONV_A)
    const first = service.navigate(CONV_A, opened.tab.id, { url: 'https://example.com/' })
    const ask = await until(() => asks[0])
    expect(ask).toMatchObject({ conversationId: CONV_A, host: 'example.com', url: 'https://example.com/' })
    ask.answer('allow')
    expect((await first).outcome).toBe('done')

    const second = service.navigate(CONV_A, opened.tab.id, { url: 'https://example.com/again' })
    const again = await until(() => asks[1])
    again.answer('allowForSession')
    expect((await second).outcome).toBe('done')
    expect((await service.navigate(CONV_A, opened.tab.id, { url: 'https://example.com/third' })).outcome).toBe('done')
    expect(asks).toHaveLength(2)

    const other = await service.open(CONV_B)
    const elsewhere = service.navigate(CONV_B, other.tab.id, { url: 'https://example.com/' })
    const third = await until(() => asks[2])
    expect(third.conversationId).toBe(CONV_B)
    third.answer('deny')
    expect((await elsewhere).outcome).toBe('denied')
  })

  it('treats a question that cannot be asked as a refusal, and leaves the page alone', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    const silent = make(() => { throw new Error('no chat is running') })
    await silent.status()
    const refused = await silent.navigate(CONV_A, opened.tab.id, { url: 'https://example.com/' })
    expect(refused).toMatchObject({ outcome: 'denied', tab: { url: 'http://localhost:5173/' } })
    expect(host.calls.filter((call) => call.method === 'navigate')).toHaveLength(1)
  })

  it('refuses the agent while the user drives a tab, and lets the user open any site', async () => {
    const connection = fakeConnection()
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    service.watch(connection, CONV_A)
    await service.userNavigate(connection, opened.tab.id, { history: 'reload' })
    expect(service.tabOf(opened.tab.id)?.userDriving).toBe(true)
    await expect(service.click(CONV_A, opened.tab.id, { ref: 'e1' })).rejects.toMatchObject({ reason: 'browser-user-driving' })
    const went = await service.userNavigate(connection, opened.tab.id, { url: 'https://example.com/' })
    expect(went.url).toBe('https://example.com/')
    expect(asks).toEqual([])
    service.handBack(connection, opened.tab.id)
    expect(service.tabOf(opened.tab.id)?.userDriving).toBe(false)
    await expect(service.click(CONV_A, opened.tab.id, { ref: 'e1' })).resolves.toBeDefined()
    const stranger = fakeConnection()
    await expect(service.userViewport(stranger, opened.tab.id, null)).rejects.toMatchObject({ reason: 'browser-not-watching' })
  })

  it('stores a screenshot as an attachment and names it for the chat', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    const shot = await service.screenshot(CONV_A, opened.tab.id, {})
    expect(shot.image).toMatchObject({ width: 16, height: 9 })
    expect(shot.image.id).toMatch(/^[0-9a-f]{64}\.png$/)
  })

  it('forgets every tab when the app goes, and connects again once it is back', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    host.drop()
    expect(service.tabsOf(CONV_A)).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'status', status: { state: 'app-closed', running: false } })
    await expect(service.snapshot(CONV_A, opened.tab.id)).rejects.toMatchObject({ reason: 'browser-tab-not-found' })
    // The app is gone: its file with it, and nothing answers until it is back.
    rmSync(hostFile)
    await expect(service.status()).resolves.toMatchObject({ state: 'app-closed', running: false, message: expect.stringContaining('Kando 应用') })
    await expect(service.open(CONV_A)).rejects.toMatchObject({ reason: 'browser-app-closed' })
    host = fakeBrowserHost()
    await writePrivateJson(hostFile, host.endpoint(2))
    service.hostFileChanged()
    await until(() => {
      const last = events.at(-1)
      return last?.type === 'status' && last.status.running ? true : undefined
    })
    await expect(service.status()).resolves.toMatchObject({ state: 'ready', running: true })
  })

  it('reads a file an app of another version left, or a port nothing answers on, as no app', async () => {
    await writePrivateJson(hostFile, { ...host.endpoint(), protocolVersion: 1 })
    await expect(service.status()).resolves.toMatchObject({ running: false, message: expect.stringContaining('一起升级') })
    await writePrivateJson(hostFile, host.endpoint())
    // A file an app left as it crashed names a port nothing answers on: the client refuses.
    const stale = new BrowserService({ browserHostFile: hostFile }, new AttachmentStore(root), () => Promise.reject(new Error('unused')), () => {}, () => Promise.reject(new Rejection('browser-unavailable', 'browser host refused: ECONNREFUSED')), () => now)
    await expect(stale.open(CONV_A)).rejects.toMatchObject({ reason: 'browser-app-closed' })
    await expect(stale.status()).resolves.toMatchObject({ state: 'app-closed', running: false })
  })

  it('holds a tab at a size for the agent or the user, and lets it follow the panel again', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/', { width: 390, height: 844 })
    expect(opened.tab.viewport).toEqual({ width: 390, height: 844 })
    const widened = await service.setViewport(CONV_A, opened.tab.id, { width: 1280, height: 800 })
    expect(widened.viewport).toEqual({ width: 1280, height: 800 })
    expect(host.calls.at(-1)).toMatchObject({ method: 'viewport', params: { tabId: opened.tab.id, viewport: { width: 1280, height: 800 } } })
    const panel = fakeConnection()
    service.watchAll(panel)
    const freed = await service.userViewport(panel, opened.tab.id, null)
    expect(freed.viewport).toBeNull()
    expect(service.tabOf(opened.tab.id)?.viewport).toBeNull()
    const moved = await service.navigate(CONV_A, opened.tab.id, { url: 'http://localhost:5173/next' }, { width: 768, height: 1024 })
    expect(moved.tab.viewport).toEqual({ width: 768, height: 1024 })
  })

  it('gives the browser panel every tab, and the user tabs of their own that no agent sees', async () => {
    const panel = fakeConnection()
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    expect(service.watchAll(panel).map((tab) => tab.id)).toEqual([opened.tab.id])
    const own = await service.newTab(panel, null, 'https://example.com/')
    expect(own.conversationId).toBeNull()
    // The user's own tab opens any site without a question.
    expect(asks).toEqual([])
    expect(service.tabsOf(CONV_A)).toHaveLength(1)
    expect(service.allTabs()).toHaveLength(2)
    expect(events.filter((event) => event.type === 'tabs' && event.conversationId === null)).not.toHaveLength(0)
    await expect(service.snapshot(CONV_A, own.id)).rejects.toMatchObject({ reason: 'browser-tab-not-found' })
    const stranger = fakeConnection()
    await expect(service.newTab(stranger, null, undefined)).rejects.toMatchObject({ reason: 'browser-not-watching' })
    service.unwatchAll(panel)
    await expect(service.closeTab(panel, own.id)).rejects.toMatchObject({ reason: 'browser-not-watching' })
  })

})
