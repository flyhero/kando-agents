import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcError, type BrowserTab, type RpcConnection, type RpcMethod, type RpcParams } from '@kando/protocol'
import { AttachmentStore } from './attachment-store'
import { browserToolsOverCore, BROWSER_ARGUMENTS } from './mcp-browser-tools'

const CONV = '8a0b5f7c-5b0e-4e8d-9d1e-0c1c2b3a4d5e'
const TAB_A = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
const TAB_B = '2b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
const tab = (id: string, url: string, active = true): BrowserTab => ({ id, conversationId: CONV, url, title: 'Page', loading: false, active, userDriving: false, agentActing: false, createdAt: 1 })

describe('browser tools over core', () => {
  let dir: string
  let calls: Array<{ method: RpcMethod; params: unknown }>
  let tabs: BrowserTab[]
  let outcome: 'done' | 'awaiting-host' | 'denied'
  let failWith: RpcError | null

  // A core that answers from the tabs the test set up.
  const rpc = {
    call: async (method: RpcMethod, params: RpcParams<RpcMethod>) => {
      calls.push({ method, params })
      if (failWith) throw failWith
      const { tabId } = params as { tabId?: string }
      const current = tabs.find((each) => each.id === tabId) ?? tab(TAB_A, 'http://localhost/')
      switch (method) {
        case 'browser.tabs': return tabs
        case 'browser.open': return { tab: tab(TAB_B, 'http://localhost:5173/'), outcome, snapshot: '- heading [ref=e1]' }
        case 'browser.navigate': return { tab: current, outcome, snapshot: outcome === 'done' ? '- link [ref=e2]' : null }
        case 'browser.screenshot': return { tab: current, image: { id: `${'d'.repeat(64)}.jpg`, width: 4, height: 2 } }
        case 'browser.console': return { messages: [{ level: 'warn', text: 'careful', at: 1 }], errors: ['boom'], failedRequests: [{ method: 'GET', url: 'http://x/', failure: 'net::ERR' }] }
        case 'browser.close': return { ok: true }
        default: return { tab: current, snapshot: `${method} done` }
      }
    }
  }
  const withCore = <T>(work: (connection: RpcConnection) => Promise<T>) => work(rpc as unknown as RpcConnection)

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-browser-tools-'))
    writeFileSync(path.join(dir, `${'d'.repeat(64)}.jpg`), Buffer.from([0xff, 0xd8, 0xff]))
    calls = []
    tabs = []
    outcome = 'done'
    failWith = null
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens a tab for the first navigation, then acts on that tab without being told which', async () => {
    const tools = browserToolsOverCore(withCore, CONV, new AttachmentStore(dir))
    const opened = await tools.call('navigate', { url: 'http://localhost:5173/' })
    expect(calls[1]).toMatchObject({ method: 'browser.open', params: { conversationId: CONV, url: 'http://localhost:5173/' } })
    expect(opened.text).toContain(`标签页 ${TAB_B}`)
    expect(opened.text).toContain('[ref=e1]')
    tabs = [tab(TAB_A, 'http://localhost/', false), tab(TAB_B, 'http://localhost:5173/')]
    const clicked = await tools.call('click', { ref: 'e1' })
    expect(calls.at(-1)).toMatchObject({ method: 'browser.click', params: { conversationId: CONV, tabId: TAB_B, ref: 'e1' } })
    expect(clicked.text).toContain('browser.click done')
  })

  it('tells the model to wait for the user, or that they refused', async () => {
    const tools = browserToolsOverCore(withCore, CONV, new AttachmentStore(dir))
    tabs = [tab(TAB_A, 'http://localhost/')]
    outcome = 'awaiting-host'
    expect((await tools.call('navigate', { url: 'https://example.com/x' })).text).toContain('等待用户确认：已在对话里请用户允许访问 example.com')
    outcome = 'denied'
    expect(await tools.call('navigate', { url: 'https://example.com/x' })).toMatchObject({ isError: true, text: '用户拒绝了访问 example.com。' })
  })

  it('returns a screenshot as a picture and names its stored copy', async () => {
    const tools = browserToolsOverCore(withCore, CONV, new AttachmentStore(dir))
    tabs = [tab(TAB_A, 'http://localhost/')]
    const shot = await tools.call('screenshot', { fullPage: true })
    expect(shot.image).toEqual({ data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), mimeType: 'image/jpeg' })
    expect(shot.text).toContain(`[kando-image ${'d'.repeat(64)}.jpg 4x2]`)
    expect(calls.at(-1)).toMatchObject({ method: 'browser.screenshot', params: { tabId: TAB_A, fullPage: true } })
  })

  it('lists, switches and closes tabs, and reads the console', async () => {
    const tools = browserToolsOverCore(withCore, CONV, new AttachmentStore(dir))
    expect((await tools.call('tabs', { action: 'list' })).text).toContain('还没有打开标签页')
    tabs = [tab(TAB_A, 'http://localhost/'), tab(TAB_B, 'http://localhost:5173/', false)]
    expect((await tools.call('tabs', { action: 'switch', tabId: TAB_B })).text).toContain(TAB_B)
    await tools.call('snapshot', {})
    expect(calls.at(-1)).toMatchObject({ method: 'browser.snapshot', params: { tabId: TAB_B } })
    expect((await tools.call('tabs', { action: 'list' })).text).toContain(`${TAB_B}（当前）`)
    expect((await tools.call('tabs', { action: 'close', tabId: TAB_B })).text).toContain('已关闭')
    expect(await tools.call('tabs', { action: 'switch', tabId: '3b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9' })).toMatchObject({ isError: true })
    const log = await tools.call('console', {})
    expect(log.text).toBe('[warn] careful\n[error] boom\n[request] GET http://x/ — net::ERR')
  })

  it('turns core\'s refusals into advice', async () => {
    const tools = browserToolsOverCore(withCore, CONV, new AttachmentStore(dir))
    failWith = new RpcError('downloading', -32000, 'browser-installing')
    expect(await tools.call('snapshot', {})).toMatchObject({ isError: true, text: expect.stringContaining('正在下载 Chromium') })
    failWith = null
    expect(await tools.call('click', { ref: 'e1' })).toMatchObject({ isError: true, text: expect.stringContaining('没有打开的标签页') })
  })

  it('checks arguments before anything is asked of core', () => {
    expect(BROWSER_ARGUMENTS.navigate.safeParse({}).success).toBe(false)
    expect(BROWSER_ARGUMENTS.navigate.safeParse({ url: 'x', history: 'back' }).success).toBe(false)
    expect(BROWSER_ARGUMENTS.click.safeParse({ ref: '12' }).success).toBe(false)
    expect(BROWSER_ARGUMENTS.wait.safeParse({}).success).toBe(false)
    expect(BROWSER_ARGUMENTS.tabs.parse({})).toEqual({ action: 'list' })
  })
})
