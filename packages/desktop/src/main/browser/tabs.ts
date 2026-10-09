import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import type { HostTab } from '@kando/protocol/node'
import type { BrowserConsole, BrowserViewport } from '@kando/protocol'
import { HostError } from './host-error'

type ConsoleEntry = BrowserConsole['messages'][number]
type FailedRequest = BrowserConsole['failedRequests'][number]
// How much of a page's console a tab keeps; the oldest goes first.
const CONSOLE_LIMIT = 200

// The app's own hold on a tab's page, beyond what Playwright sees of it.
export type TabAttachment = {
  close(): Promise<void>
  setViewport(viewport: BrowserViewport | null): Promise<void>
}

export type Tab = {
  id: string
  conversationId: string | null
  page: Page
  attachment: TabAttachment
  title: string
  loading: boolean
  // The size the tab is held at, or null while it follows the panel.
  viewport: BrowserViewport | null
  createdAt: number
  messages: ConsoleEntry[]
  errors: string[]
  failedRequests: FailedRequest[]
  // Where the console stood when the tab last navigated, for reading only what came after.
  navigationMark: { messages: number; errors: number; failedRequests: number }
}

// The pages open, by id, tagged with the conversation each belongs to. Whatever the page does on
// its own (a redirect, a title change, a console line) is noted here as it happens.
export class TabRegistry {
  private readonly tabs = new Map<string, Tab>()
  private readonly activeByConversation = new Map<string, string>()

  constructor(private readonly changed: () => void) {}

  add(conversationId: string | null, page: Page, attachment: TabAttachment, viewport: BrowserViewport | null = null): Tab {
    const tab: Tab = {
      id: randomUUID(),
      conversationId,
      page,
      attachment,
      title: '',
      loading: false,
      viewport,
      createdAt: Date.now(),
      messages: [],
      errors: [],
      failedRequests: [],
      navigationMark: { messages: 0, errors: 0, failedRequests: 0 }
    }
    this.tabs.set(tab.id, tab)
    this.activeByConversation.set(owner(conversationId), tab.id)
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        tab.loading = true
        this.changed()
      }
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      tab.navigationMark = { messages: tab.messages.length, errors: tab.errors.length, failedRequests: tab.failedRequests.length }
      this.changed()
    })
    page.on('load', () => {
      tab.loading = false
      void this.refreshTitle(tab)
    })
    page.on('console', (message) => {
      push(tab, tab.messages, { level: message.type(), text: message.text().slice(0, 4000), at: Date.now() }, 'messages')
    })
    page.on('pageerror', (error) => push(tab, tab.errors, error.message.slice(0, 4000), 'errors'))
    page.on('requestfailed', (request) => {
      push(tab, tab.failedRequests, { method: request.method(), url: request.url().slice(0, 4096), failure: request.failure()?.errorText.slice(0, 500) ?? '' }, 'failedRequests')
    })
    page.on('close', () => this.remove(tab.id))
    this.changed()
    return tab
  }

  // The tab is gone, from whichever side noticed first (the page closing, the view destroyed).
  remove(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.tabs.delete(tabId)
    const key = owner(tab.conversationId)
    if (this.activeByConversation.get(key) === tabId) {
      const next = this.ofConversation(tab.conversationId).at(-1)
      if (next) this.activeByConversation.set(key, next.id)
      else this.activeByConversation.delete(key)
    }
    this.changed()
  }

  get(tabId: string): Tab {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.page.isClosed()) throw new HostError('browser-tab-not-found', '标签页不存在')
    return tab
  }

  byPage(page: Page): Tab | null {
    for (const tab of this.tabs.values()) if (tab.page === page) return tab
    return null
  }

  // The tab was just used: it is the conversation's default from now on.
  touch(tab: Tab): void {
    if (this.activeByConversation.get(owner(tab.conversationId)) !== tab.id) {
      this.activeByConversation.set(owner(tab.conversationId), tab.id)
      this.changed()
    }
  }

  setViewport(tab: Tab, viewport: BrowserViewport | null): void {
    tab.viewport = viewport
    this.changed()
  }

  ofConversation(conversationId: string | null): Tab[] {
    return [...this.tabs.values()].filter((tab) => tab.conversationId === conversationId)
  }

  all(): Tab[] {
    return [...this.tabs.values()]
  }

  get size(): number {
    return this.tabs.size
  }

  list(): HostTab[] {
    return [...this.tabs.values()].map((tab) => this.describe(tab))
  }

  describe(tab: Tab): HostTab {
    return {
      id: tab.id,
      conversationId: tab.conversationId,
      url: tab.page.url().slice(0, 4096),
      title: tab.title.slice(0, 500),
      loading: tab.loading,
      active: this.activeByConversation.get(owner(tab.conversationId)) === tab.id,
      viewport: tab.viewport,
      createdAt: tab.createdAt
    }
  }

  // The title is read, not pushed by the page, so it is refreshed after loads and actions.
  async refreshTitle(tab: Tab): Promise<void> {
    try {
      const title = await tab.page.title()
      if (title !== tab.title) {
        tab.title = title
        this.changed()
      }
    } catch {
      // The page went away under us; its close event has the rest.
    }
  }

  console(tab: Tab, sinceNavigation: boolean): BrowserConsole {
    const mark = sinceNavigation ? tab.navigationMark : { messages: 0, errors: 0, failedRequests: 0 }
    return {
      messages: tab.messages.slice(mark.messages),
      errors: tab.errors.slice(mark.errors),
      failedRequests: tab.failedRequests.slice(mark.failedRequests)
    }
  }
}

// The user's own tabs are one group, keyed apart from any conversation's.
function owner(conversationId: string | null): string {
  return conversationId ?? ''
}

// Keeps the list to its limit; the navigation mark moves with the entries it points at.
function push<T>(tab: Tab, list: T[], entry: T, key: keyof Tab['navigationMark']): void {
  list.push(entry)
  if (list.length > CONSOLE_LIMIT) {
    list.shift()
    tab.navigationMark[key] = Math.max(0, tab.navigationMark[key] - 1)
  }
}
