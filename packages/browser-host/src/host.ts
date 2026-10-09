import { chromium, type BrowserContext } from 'playwright-core'
import { BROWSER_VIEWPORT, normalizeBrowserUrl, type BrowserNavigateTo, type BrowserStatus } from '@kando/protocol'
import type { BrowserHostResult, KandoPaths } from '@kando/protocol/node'
import * as actions from './actions'
import { chromiumInstalled, installChromium } from './chromium'
import { HostError } from './host-error'
import { HostGate } from './host-gate'
import { freeProfile } from './profile-lock'
import { Screencast } from './screencast'
import { startHostServer, type HostServer } from './server'
import { TabRegistry, type Tab } from './tabs'

// A host with nothing open for this long shuts down; core starts one again when it is wanted.
const IDLE_MS = 10 * 60_000
const IDLE_CHECK_MS = 60_000
// Longer than the gate's wait, so a navigation held for the user is not a timeout.
const NAVIGATION_TIMEOUT_MS = 35_000

type Navigation = BrowserHostResult<'navigate'>

export async function startBrowserHost(paths: KandoPaths, exit: (code: number) => void = (code) => process.exit(code)): Promise<HostServer> {
  let status: BrowserStatus = { state: chromiumInstalled() ? 'ready' : 'not-installed', running: true }
  let context: BrowserContext | null = null
  let launching: Promise<BrowserContext> | null = null
  let installing: Promise<void> | null = null
  let screencast: Screencast | null = null
  let lastActivity = Date.now()
  let closing = false

  const registry = new TabRegistry(() => server?.emit({ event: 'tabs', tabs: registry.list() }))
  const gate = new HostGate(registry, (check) => server?.emit({ event: 'hostCheck', ...check }))
  let server: HostServer | null = null

  const setStatus = (next: BrowserStatus) => {
    status = next
    server?.emit({ event: 'status', status })
  }

  const install = (): Promise<void> => {
    if (status.state === 'ready') return Promise.resolve()
    if (installing) return installing
    setStatus({ state: 'installing', running: true })
    installing = installChromium((percent) => setStatus({ state: 'installing', percent, running: true }))
      .then(() => setStatus({ state: 'ready', running: true }))
      .catch((error: unknown) => {
        setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error), running: true })
        throw error
      })
      .finally(() => {
        installing = null
      })
    return installing
  }

  const ensureContext = async (): Promise<BrowserContext> => {
    if (context) return context
    if (launching) return launching
    if (status.state === 'installing') throw new HostError('browser-installing', '浏览器正在下载')
    if (status.state !== 'ready') {
      void install().catch(() => {})
      throw new HostError('browser-installing', '浏览器正在下载')
    }
    setStatus({ state: 'starting', running: true })
    launching = (async () => {
      try {
        const ended = await freeProfile(paths.browserProfile)
        if (ended !== null) console.error(`[browser-host] ended browser host ${ended}, which still held the profile`)
        // The full build in its new headless mode, which real sites and logins tolerate; the
        // profile keeps cookies across hosts. Chromium's automation banner has no window to show in.
        const launched = await chromium.launchPersistentContext(paths.browserProfile, {
          channel: 'chromium',
          headless: true,
          viewport: BROWSER_VIEWPORT,
          ignoreDefaultArgs: ['--enable-automation']
        })
        await gate.install(launched)
        for (const page of launched.pages()) await page.close().catch(() => {})
        launched.on('close', () => {
          if (closing) return
          console.error('[browser-host] the browser closed on its own')
          exit(2)
        })
        screencast = new Screencast(launched, (frame) => server?.emit({ event: 'frame', ...frame }))
        context = launched
        setStatus({ state: 'ready', running: true })
        return launched
      } catch (error) {
        setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error), running: true })
        throw error
      } finally {
        launching = null
      }
    })()
    return launching
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
    lastActivity = Date.now()
    registry.touch(tab)
    await run(tab)
    await actions.settle(tab.page)
    await registry.refreshTitle(tab)
    return { tab: registry.describe(tab), snapshot: await actions.snapshot(tab.page) }
  }

  const shutdown = async (code: number) => {
    if (closing) return
    closing = true
    gate.cancelAll()
    await context?.close().catch(() => {})
    await server?.close()
    exit(code)
  }

  server = await startHostServer({
    status: () => status,
    // Answers at once with the download under way; progress follows as status events.
    install: () => {
      lastActivity = Date.now()
      void install().catch(() => {})
      return status
    },
    'tabs.list': () => ({ tabs: registry.list() }),
    'tabs.open': async ({ conversationId, url }) => {
      lastActivity = Date.now()
      const page = await (await ensureContext()).newPage()
      const tab = registry.add(conversationId ?? null, page)
      if (!url) return { tab: registry.describe(tab), outcome: 'done', snapshot: null }
      return goto(tab, { url })
    },
    'tabs.close': async ({ tabId }) => {
      lastActivity = Date.now()
      await registry.get(tabId).page.close()
      return { ok: true }
    },
    'tabs.closeAll': async ({ conversationId }) => {
      for (const tab of registry.ofConversation(conversationId)) await tab.page.close().catch(() => {})
      return { ok: true }
    },
    navigate: async ({ tabId, to }) => {
      const tab = registry.get(tabId)
      lastActivity = Date.now()
      registry.touch(tab)
      return goto(tab, to)
    },
    snapshot: ({ tabId }) => act(tabId, async () => {}),
    screenshot: async ({ tabId, ...options }) => {
      const tab = registry.get(tabId)
      lastActivity = Date.now()
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
    'screencast.start': async ({ tabId, ...options }) => {
      const tab = registry.get(tabId)
      if (!screencast) throw new HostError('browser-unavailable', '浏览器没有运行')
      await screencast.start(tab.id, tab.page, options)
      return { ok: true }
    },
    'screencast.stop': async ({ tabId }) => {
      await screencast?.stop(tabId)
      return { ok: true }
    },
    input: async ({ tabId, event }) => {
      const tab = registry.get(tabId)
      if (!screencast) throw new HostError('browser-unavailable', '浏览器没有运行')
      lastActivity = Date.now()
      await screencast.input(tab.id, tab.page, event)
      return { ok: true }
    },
    shutdown: () => {
      void shutdown(0)
      return { ok: true }
    }
  })

  const idle = setInterval(() => {
    if (registry.size === 0 && Date.now() - lastActivity > IDLE_MS && !installing) void shutdown(0)
  }, IDLE_CHECK_MS)
  idle.unref()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(0))

  return server
}
