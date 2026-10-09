import { randomUUID } from 'node:crypto'
import { isLocalHost, type BrowserNavigationOutcome } from '@kando/protocol'
import { BROWSER_HOST_PROTOCOL_VERSION, type BrowserHostEndpoint, type BrowserHostEvent, type BrowserHostMethod, type BrowserHostParams, type BrowserHostResult, type HostTab } from '@kando/protocol/node'
import type { HostLink } from './browser-host-client'
import { pngBytes } from './image-fixtures'
import { Rejection } from './rejection'

type Check = { checkId: string; tabId: string; resolve: (allow: boolean) => void }

// For tests: a browser host in memory. Tabs open and navigate at once; a site outside local
// development raises a hostCheck and waits for host.resolve, as the real gate does.
export function fakeBrowserHost() {
  const tabs = new Map<string, HostTab>()
  const checks: Check[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const eventListeners = new Set<(event: BrowserHostEvent) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false

  const emit = (event: BrowserHostEvent) => eventListeners.forEach((listener) => listener(event))
  const tabsEvent = () => emit({ event: 'tabs', tabs: [...tabs.values()] })
  const tab = (tabId: string): HostTab => {
    const found = tabs.get(tabId)
    if (!found) throw new Rejection('browser-tab-not-found', '标签页不存在')
    return found
  }
  const activate = (tabId: string) => {
    const current = tab(tabId)
    for (const each of tabs.values()) if (each.conversationId === current.conversationId) each.active = each.id === tabId
  }
  // Waits for core's answer when the host is outside local development.
  const gate = (tabId: string, url: string): Promise<BrowserNavigationOutcome> => {
    const host = new URL(url).hostname
    const current = tab(tabId)
    if (isLocalHost(host) || current.conversationId === null) return Promise.resolve('done')
    return new Promise((resolve) => {
      const checkId = randomUUID()
      checks.push({ checkId, tabId, resolve: (allow) => resolve(allow ? 'done' : 'denied') })
      emit({ event: 'hostCheck', checkId, tabId, conversationId: current.conversationId, host, url })
    })
  }
  const navigate = async (tabId: string, url: string) => {
    const current = tab(tabId)
    current.loading = true
    tabsEvent()
    const outcome = await gate(tabId, url)
    current.loading = false
    if (outcome === 'done') {
      current.url = url
      current.title = `Title of ${new URL(url).hostname}`
    }
    tabsEvent()
    return { tab: current, outcome, snapshot: outcome === 'done' ? `- heading "${current.title}" [ref=e1]` : null }
  }

  const handlers: { [M in BrowserHostMethod]: (params: BrowserHostParams<M>) => Promise<BrowserHostResult<M>> | BrowserHostResult<M> } = {
    status: () => ({ state: 'ready', running: true }),
    'tabs.list': () => ({ tabs: [...tabs.values()] }),
    'tabs.open': async ({ conversationId, url, viewport }) => {
      const opened: HostTab = { id: randomUUID(), conversationId: conversationId ?? null, url: 'about:blank', title: '', loading: false, active: true, viewport: viewport ?? null, createdAt: Date.now() }
      tabs.set(opened.id, opened)
      activate(opened.id)
      tabsEvent()
      return url ? navigate(opened.id, url) : { tab: opened, outcome: 'done', snapshot: null }
    },
    'tabs.close': ({ tabId }) => {
      tab(tabId)
      tabs.delete(tabId)
      tabsEvent()
      return { ok: true }
    },
    'tabs.closeAll': ({ conversationId }) => {
      for (const each of [...tabs.values()]) if (each.conversationId === conversationId) tabs.delete(each.id)
      tabsEvent()
      return { ok: true }
    },
    navigate: ({ tabId, to, viewport }) => {
      activate(tabId)
      if (viewport !== undefined) tab(tabId).viewport = viewport
      return 'url' in to ? navigate(tabId, to.url) : { tab: tab(tabId), outcome: 'done', snapshot: `after ${to.history}` }
    },
    viewport: ({ tabId, viewport }) => {
      tab(tabId).viewport = viewport
      tabsEvent()
      return { ok: true }
    },
    snapshot: ({ tabId }) => ({ tab: tab(tabId), snapshot: `- heading "${tab(tabId).title}" [ref=e1]` }),
    screenshot: ({ tabId }) => ({ tab: tab(tabId), jpeg: Buffer.from(pngBytes(16, 9)).toString('base64') }),
    click: ({ tabId, ref }) => ({ tab: tab(tabId), snapshot: `clicked ${ref}` }),
    type: ({ tabId, ref, text }) => ({ tab: tab(tabId), snapshot: `typed ${text} into ${ref}` }),
    press: ({ tabId, key }) => ({ tab: tab(tabId), snapshot: `pressed ${key}` }),
    hover: ({ tabId, ref }) => ({ tab: tab(tabId), snapshot: `hovered ${ref}` }),
    scroll: ({ tabId, direction }) => ({ tab: tab(tabId), snapshot: `scrolled ${direction}` }),
    select: ({ tabId, values }) => ({ tab: tab(tabId), snapshot: `selected ${values.join(',')}` }),
    wait: ({ tabId }) => ({ tab: tab(tabId), snapshot: 'waited' }),
    console: () => ({ messages: [{ level: 'log', text: 'hello', at: 1 }], errors: [], failedRequests: [] }),
    'host.resolve': ({ checkId, allow }) => {
      const index = checks.findIndex((check) => check.checkId === checkId)
      if (index >= 0) checks.splice(index, 1)[0]?.resolve(allow)
      return { ok: true }
    },
    shutdown: () => ({ ok: true })
  }

  const link: HostLink = {
    async request(method, params) {
      if (closed) throw new Rejection('browser-unavailable', '浏览器没有运行')
      calls.push({ method, params })
      const handler = handlers[method]
      return handler(params)
    },
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close: () => {
      closed = true
    }
  }

  return {
    link,
    tabs,
    checks,
    calls,
    emit,
    // What the app writes to the host file while it is up.
    endpoint: (pid = 1): BrowserHostEndpoint => ({ port: 1, token: 't', pid, protocolVersion: BROWSER_HOST_PROTOCOL_VERSION }),
    connect: async (_endpoint?: BrowserHostEndpoint) => link,
    // The app went away: what core sees when the socket drops.
    drop: () => {
      closed = true
      closeListeners.forEach((listener) => listener())
    }
  }
}
