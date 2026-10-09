import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatDecision } from '@kando/protocol'
import { AttachmentStore } from './attachment-store'
import { BrowserService, type BrowserEvent } from './browser-service'
import { fakeBrowserHost } from './fake-browser-host'
import { fakeChatDaemon } from './fake-chat-agent'
import { fakeConnection, until } from './fake-connection'
import { readJsonIfExists } from '@kando/protocol/node'

const CONV_A = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
const CONV_B = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'

describe('BrowserService', () => {
  let root: string
  let daemon: ReturnType<typeof fakeChatDaemon>
  let host: ReturnType<typeof fakeBrowserHost>
  let events: BrowserEvent[]
  let asks: Array<{ conversationId: string; host: string; url: string; answer: (decision: ChatDecision) => void; drop: () => void }>
  let service: BrowserService
  let now: number

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-browser-'))
    mkdirSync(path.join(root, 'attachments'))
    mkdirSync(path.join(root, 'browser'))
    daemon = fakeChatDaemon()
    host = fakeBrowserHost()
    events = []
    asks = []
    now = 1_800_000_000_000
    service = new BrowserService(
      daemon,
      { home: root, browser: path.join(root, 'browser'), browserBinaries: path.join(root, 'browser', 'ms-playwright'), browserHostFile: path.join(root, 'browser', 'host.json') },
      () => ['node', 'host.mjs'],
      new AttachmentStore(path.join(root, 'attachments')),
      (conversationId, hostName, url) => new Promise((resolve, reject) => asks.push({ conversationId, host: hostName, url, answer: resolve, drop: () => reject(new Error('gone')) })),
      (event) => events.push(event),
      (endpoint) => host.connect(endpoint),
      () => now
    )
    // The daemon's output reaches the service the way main.ts routes it, and the fake host
    // prints its listening line as soon as it is spawned.
    daemon.deliver = (event) => {
      if (event.event === 'data') service.handleData(event)
      if (event.event === 'exit') service.handleExit(event.sessionId)
    }
    const spawn = daemon.spawns
    const seen = spawn.length
    void until(() => (spawn.length > seen ? true : undefined)).then(() => daemon.emit(`pipe-${spawn.length}`, host.listening()))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('starts the host through the daemon, records its session, and opens tabs for a conversation', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    expect(daemon.spawns[0]).toMatchObject({ command: 'node', args: ['host.mjs'], env: { KANDO_HOME: root } })
    expect(await readJsonIfExists(path.join(root, 'browser', 'host.json'))).toEqual({ sessionId: 'pipe-1' })
    expect(opened).toMatchObject({ outcome: 'done', tab: { conversationId: CONV_A, url: 'http://localhost:5173/', active: true, userDriving: false, agentActing: false } })
    expect(opened.snapshot).toContain('[ref=e1]')
    expect(service.tabsOf(CONV_A)).toHaveLength(1)
    expect(service.tabsOf(CONV_B)).toEqual([])
    expect(events.find((event) => event.type === 'status')).toMatchObject({ status: { state: 'ready', running: true } })
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
    const silent = new BrowserService(
      daemon,
      { home: root, browser: path.join(root, 'browser'), browserBinaries: '', browserHostFile: path.join(root, 'browser', 'host.json') },
      () => ['node'],
      new AttachmentStore(root),
      () => { throw new Error('no chat is running') },
      () => {},
      (endpoint) => host.connect(endpoint),
      () => now
    )
    await silent.reconcile([{ sessionId: 'pipe-1', exited: false, exitCode: null, io: 'pipe' }])
    const refused = await silent.navigate(CONV_A, opened.tab.id, { url: 'https://example.com/' })
    expect(refused).toMatchObject({ outcome: 'denied', tab: { url: 'http://localhost:5173/' } })
    expect(host.calls.filter((call) => call.method === 'navigate')).toHaveLength(1)
  })

  it('refuses the agent while the user drives a tab, and lets the user open any site', async () => {
    const connection = fakeConnection()
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    service.watch(connection, CONV_A)
    await service.input(connection, opened.tab.id, { type: 'text', text: 'hi' })
    expect(service.tabOf(opened.tab.id)?.userDriving).toBe(true)
    await expect(service.click(CONV_A, opened.tab.id, { ref: 'e1' })).rejects.toMatchObject({ reason: 'browser-user-driving' })
    const went = await service.userNavigate(connection, opened.tab.id, { url: 'https://example.com/' })
    expect(went.url).toBe('https://example.com/')
    expect(asks).toEqual([])
    service.handBack(connection, opened.tab.id)
    expect(service.tabOf(opened.tab.id)?.userDriving).toBe(false)
    await expect(service.click(CONV_A, opened.tab.id, { ref: 'e1' })).resolves.toBeDefined()
    const stranger = fakeConnection()
    await expect(service.input(stranger, opened.tab.id, { type: 'text', text: 'x' })).rejects.toMatchObject({ reason: 'browser-not-watching' })
  })

  it('stores a screenshot as an attachment and names it for the chat', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    const shot = await service.screenshot(CONV_A, opened.tab.id, {})
    expect(shot.image).toMatchObject({ width: 16, height: 9 })
    expect(shot.image.id).toMatch(/^[0-9a-f]{64}\.png$/)
  })

  it('forgets every tab when the host goes, and starts another on the next call', async () => {
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    host.drop()
    expect(service.tabsOf(CONV_A)).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'status', status: { running: false } })
    await expect(service.snapshot(CONV_A, opened.tab.id)).rejects.toMatchObject({ reason: 'browser-tab-not-found' })
    await until(() => (existsSync(path.join(root, 'browser', 'host.json')) ? undefined : true))
    const seen = daemon.spawns.length
    void until(() => (daemon.spawns.length > seen ? true : undefined)).then(() => daemon.emit(`pipe-${daemon.spawns.length}`, host.listening(2)))
    host = fakeBrowserHost()
    await expect(service.status()).resolves.toMatchObject({ running: true })
    expect(daemon.spawns).toHaveLength(2)
  })

  it('takes a host an earlier core left running, found through host.json', async () => {
    await service.open(CONV_A, 'http://localhost:5173/')
    const again = new BrowserService(
      daemon,
      { home: root, browser: path.join(root, 'browser'), browserBinaries: path.join(root, 'browser', 'ms-playwright'), browserHostFile: path.join(root, 'browser', 'host.json') },
      () => ['node', 'host.mjs'],
      new AttachmentStore(path.join(root, 'attachments')),
      () => Promise.reject(new Error('unused')),
      () => {},
      host.connect,
      () => now
    )
    await again.reconcile([{ sessionId: 'pipe-1', exited: false, exitCode: null, io: 'pipe' }])
    expect(again.tabsOf(CONV_A)).toHaveLength(1)
    expect(daemon.spawns).toHaveLength(1)

    const gone = new BrowserService(daemon, { home: root, browser: path.join(root, 'browser'), browserBinaries: '', browserHostFile: path.join(root, 'browser', 'host.json') }, () => ['node'], new AttachmentStore(root), () => Promise.reject(new Error('unused')), () => {}, host.connect, () => now)
    await gone.reconcile([])
    expect(await readJsonIfExists(path.join(root, 'browser', 'host.json'))).toBeUndefined()
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
    await service.startView(panel, own.id, {})
    await service.input(panel, own.id, { type: 'text', text: 'x' })
    const stranger = fakeConnection()
    await expect(service.newTab(stranger, null, undefined)).rejects.toMatchObject({ reason: 'browser-not-watching' })
    await service.unwatchAll(panel)
    await expect(service.closeTab(panel, own.id)).rejects.toMatchObject({ reason: 'browser-not-watching' })
  })

  it('streams frames only to the connection viewing the tab, two at a time', async () => {
    const connection = fakeConnection()
    const other = fakeConnection()
    const opened = await service.open(CONV_A, 'http://localhost:5173/')
    service.watch(connection, CONV_A)
    await expect(service.startView(other, opened.tab.id, {})).rejects.toMatchObject({ reason: 'browser-not-watching' })
    await service.startView(connection, opened.tab.id, { maxWidth: 640 })
    expect(host.calls.at(-1)).toMatchObject({ method: 'screencast.start', params: { tabId: opened.tab.id, maxWidth: 640 } })
    host.frame(opened.tab.id, 1)
    host.frame(opened.tab.id, 2)
    host.frame(opened.tab.id, 3)
    expect(connection.notes.filter((note) => note.name === 'browser.frame').map((note) => note.params)).toMatchObject([{ seq: 1 }, { seq: 2 }])
    service.views.ack(connection, opened.tab.id, 1)
    host.frame(opened.tab.id, 4)
    expect(connection.notes.filter((note) => note.name === 'browser.frame')).toHaveLength(3)
    // A second tab viewed beside the first keeps both streaming until each is stopped.
    const second = await service.open(CONV_A, 'http://localhost:5174/')
    await service.startView(connection, second.tab.id, {})
    host.frame(second.tab.id, 1)
    expect(connection.notes.filter((note) => note.name === 'browser.frame')).toHaveLength(4)
    await service.views.stop(connection, second.tab.id)
    expect(host.calls.filter((call) => call.method === 'screencast.stop')).toHaveLength(1)
    host.frame(second.tab.id, 2)
    expect(connection.notes.filter((note) => note.name === 'browser.frame')).toHaveLength(4)
    connection.close()
    await until(() => (host.calls.filter((call) => call.method === 'screencast.stop').length === 2 ? true : undefined))
  })
})
