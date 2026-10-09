import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { WebContentsView, type WebContents } from 'electron'
import { chromium } from 'playwright-core'
import { BROWSER_HOST_PROTOCOL_VERSION, writePrivateJson, type BrowserHostResult } from '@kando/protocol/node'
import { BROWSER_VIEWPORT, normalizeBrowserUrl, type BrowserNavigateTo, type BrowserStatus, type BrowserViewport } from '@kando/protocol'
import * as actions from './actions'
import { HostError } from './host-error'
import { HostGate } from './host-gate'
import { startHostServer, type HostServer } from './host-server'
import { startTabProxy } from './tab-cdp-proxy'
import { TabRegistry, type Tab } from './tabs'
import { applyViewport } from './viewport'
import type { WindowSlot } from './window-slot'

// One session for every tab: cookies and logins outlive the app, apart from its own UI's.
const PARTITION = 'persist:kando-browser'
// Longer than the gate's wait, so a navigation held for the user is not a timeout.
const NAVIGATION_TIMEOUT_MS = 35_000
const READY: BrowserStatus = { state: 'ready', running: true }

type Navigation = BrowserHostResult<'navigate'>

export type BrowserHost = {
  server: HostServer
  viewOf(tabId: string): WebContentsView | null
  viewportOf(tabId: string): BrowserViewport | null
  shutdown(): Promise<void>
}

// The browser host, in the app: tabs are WebContentsViews, driven for the agent through Playwright
// over each tab's own CDP proxy, and shown to the user by the window slot. Core connects over the
// host server, finding it through the host file, and keeps every policy; this only does.
export async function startBrowserHost(slot: WindowSlot, hostFile: string): Promise<BrowserHost> {
  const views = new Map<string, WebContentsView>()
  let server: HostServer | null = null
  let closing = false

  const registry = new TabRegistry(() => server?.emit({ event: 'tabs', tabs: registry.list() }))
  const gate = new HostGate(registry, (check) => server?.emit({ event: 'hostCheck', ...check }))

  const forget = (tab: Tab) => {
    views.delete(tab.id)
    slot.tabClosed(tab.id)
    registry.remove(tab.id)
  }

  const open = async (conversationId: string | null, viewport: BrowserViewport | null): Promise<Tab> => {
    // A tab off the panel still lays out, paints and runs its frames: the agent's clicks wait
    // on an element being visible and still, which a throttled or sizeless page never is.
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    view.setBounds({ x: 0, y: 0, ...BROWSER_VIEWPORT })
    const contents = view.webContents
    await contents.loadURL('about:blank')
    const proxy = await startTabProxy(contents)
    const browser = await chromium.connectOverCDP(proxy.endpoint).catch((error: unknown) => {
      proxy.close()
      contents.close()
      throw error
    })
    const page = browser.contexts()[0]?.pages()[0]
    if (!page) {
      await browser.close().catch(() => {})
      proxy.close()
      contents.close()
      throw new HostError('browser-unavailable', '标签页没有打开')
    }
    await gate.install(page.context())
    if (viewport) await applyViewport(contents, viewport)
    let tab: Tab
    const close = async () => {
      if (!views.has(tab.id)) return
      forget(tab)
      await browser.close().catch(() => {})
      proxy.close()
      if (!contents.isDestroyed()) contents.close()
    }
    tab = registry.add(conversationId, page, {
      close,
      setViewport: async (next) => {
        await applyViewport(contents, next)
        registry.setViewport(tab, next)
        slot.setViewport(tab.id, next)
      }
    }, viewport)
    views.set(tab.id, view)
    contents.once('destroyed', () => void close())
    // A link that wants a window of its own gets a tab of the same owner's instead.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void open(tab.conversationId, null).then((opened) => goto(opened, { url })).catch(() => {})
      return { action: 'deny' }
    })
    keysForApp(contents, tab.id, slot)
    contents.on('focus', () => slot.sendToRenderer('kando:browser-focused', { tabId: tab.id, focused: true }))
    contents.on('blur', () => slot.sendToRenderer('kando:browser-focused', { tabId: tab.id, focused: false }))
    return tab
  }

  const goto = async (tab: Tab, to: BrowserNavigateTo): Promise<Navigation> => {
    const { page } = tab
    try {
      if ('url' in to) await page.goto(normalizeBrowserUrl(to.url), { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
      else if (to.history === 'back') await page.goBack({ waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
      else if (to.history === 'forward') await page.goForward({ waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
      else await page.reload({ waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
    } catch (error) {
      const outcome = gate.takeOutcome(tab.id)
      if (outcome !== 'done') return { tab: registry.describe(tab), outcome, snapshot: null }
      const message = error instanceof Error ? error.message : String(error)
      // A slow page still shows what it has; anything else is a failure the agent should know.
      if (!/Timeout/i.test(message)) throw new HostError('browser-navigation-failed', message.split('\n')[0] ?? message)
    }
    await registry.refreshTitle(tab)
    return { tab: registry.describe(tab), outcome: 'done', snapshot: await actions.snapshot(page) }
  }

  // An action on a tab, then the page as it stands afterwards.
  const act = async (tabId: string, run: (tab: Tab) => Promise<void>): Promise<BrowserHostResult<'click'>> => {
    const tab = registry.get(tabId)
    registry.touch(tab)
    await run(tab)
    await actions.settle(tab.page)
    await registry.refreshTitle(tab)
    return { tab: registry.describe(tab), snapshot: await actions.snapshot(tab.page) }
  }

  const shutdown = async () => {
    if (closing) return
    closing = true
    gate.cancelAll()
    await Promise.all(registry.all().map((tab) => tab.attachment.close()))
    await server?.close()
    await rm(hostFile, { force: true }).catch(() => {})
  }

  server = await startHostServer({
    status: () => READY,
    'tabs.list': () => ({ tabs: registry.list() }),
    'tabs.open': async ({ conversationId, url, viewport }) => {
      const tab = await open(conversationId ?? null, viewport ?? null)
      if (!url) return { tab: registry.describe(tab), outcome: 'done', snapshot: null }
      return goto(tab, { url })
    },
    'tabs.close': async ({ tabId }) => {
      await registry.get(tabId).attachment.close()
      return { ok: true }
    },
    'tabs.closeAll': async ({ conversationId }) => {
      for (const tab of registry.ofConversation(conversationId)) await tab.attachment.close().catch(() => {})
      return { ok: true }
    },
    navigate: async ({ tabId, to, viewport }) => {
      const tab = registry.get(tabId)
      registry.touch(tab)
      if (viewport !== undefined && JSON.stringify(viewport) !== JSON.stringify(tab.viewport)) await tab.attachment.setViewport(viewport)
      return goto(tab, to)
    },
    viewport: async ({ tabId, viewport }) => {
      await registry.get(tabId).attachment.setViewport(viewport)
      return { ok: true }
    },
    snapshot: ({ tabId }) => act(tabId, async () => {}),
    screenshot: async ({ tabId, ...options }) => {
      const tab = registry.get(tabId)
      registry.touch(tab)
      const jpeg = await actions.screenshot(tab.page, options)
      return { tab: registry.describe(tab), jpeg: jpeg.toString('base64') }
    },
    click: ({ tabId, ...params }) => act(tabId, (tab) => actions.click(tab.page, params)),
    type: ({ tabId, ...params }) => act(tabId, (tab) => actions.type(tab.page, params)),
    press: ({ tabId, ...params }) => act(tabId, (tab) => actions.press(tab.page, params)),
    hover: ({ tabId, ...params }) => act(tabId, (tab) => actions.hover(tab.page, params)),
    scroll: ({ tabId, ...params }) => act(tabId, (tab) => actions.scroll(tab.page, params)),
    select: ({ tabId, ...params }) => act(tabId, (tab) => actions.select(tab.page, params)),
    wait: ({ tabId, ...params }) => act(tabId, (tab) => actions.wait(tab.page, params)),
    console: ({ tabId, sinceNavigation }) => registry.console(registry.get(tabId), sinceNavigation ?? false),
    'host.resolve': ({ checkId, allow }) => {
      gate.resolve(checkId, allow)
      return { ok: true }
    },
    shutdown: () => {
      void shutdown()
      return { ok: true }
    }
  })

  await mkdir(path.dirname(hostFile), { recursive: true, mode: 0o700 })
  await writePrivateJson(hostFile, { port: server.port, token: server.token, pid: process.pid, protocolVersion: BROWSER_HOST_PROTOCOL_VERSION })

  return {
    server,
    viewOf: (tabId) => views.get(tabId) ?? null,
    viewportOf: (tabId) => {
      try {
        return registry.get(tabId).viewport
      } catch {
        return null
      }
    },
    shutdown
  }
}

// With a tab focused, the window's page sees no keys: the app's own are answered here. Escape
// returns to the app; Shift+Escape reaches the page as a plain Escape, as the old live view did.
// The zoom keys stay the app's, so a page is never scaled under the agent.
function keysForApp(contents: WebContents, tabId: string, slot: WindowSlot): void {
  contents.setVisualZoomLevelLimits(1, 1).catch(() => {})
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const command = process.platform === 'darwin' ? input.meta : input.control
    if (input.key === 'Escape') {
      event.preventDefault()
      if (input.shift) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      } else {
        slot.focusApp()
        slot.sendToRenderer('kando:browser-focused', { tabId, focused: false })
      }
      return
    }
    if (!command) return
    if (input.shift && input.code === 'Backquote') {
      event.preventDefault()
      slot.sendToRenderer('kando:browser-shortcut', { kind: 'toggle-browser' })
    } else if (input.key === ',') {
      event.preventDefault()
      slot.sendToRenderer('kando:browser-shortcut', { kind: 'settings' })
    } else if (['=', '+', '-', '0'].includes(input.key)) {
      event.preventDefault()
    }
  })
}
