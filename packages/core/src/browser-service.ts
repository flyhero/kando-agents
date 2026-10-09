import { z } from 'zod'
import {
  BROWSER_HOST_DECISION_WAIT_MS,
  browserHostOf,
  isLocalHost,
  type AttachmentInfo,
  type BrowserAction,
  type BrowserConsole,
  type BrowserNavigateTo,
  type BrowserNavigation,
  type BrowserScreenshot,
  type BrowserStatus,
  type BrowserTab,
  type BrowserViewport,
  type ChatDecision,
  type browserActions
} from '@kando/protocol'
import { BROWSER_HOST_PROTOCOL_VERSION, type BrowserHostEvent, type BrowserHostParams, type HostTab, type KandoPaths } from '@kando/protocol/node'
import type { AttachmentStore } from './attachment-store'
import { connectBrowserHost, type HostConnect, type HostLink } from './browser-host-client'
import { readBrowserHostEndpoint } from './browser-host-file'
import { clip } from './chat-items'
import { Rejection } from './rejection'
import type { Connection } from './rpc-server'

// tabs with conversationId null are the user's own, for whoever watches all of them.
export type BrowserEvent =
  | { type: 'status'; status: BrowserStatus }
  | { type: 'tabs'; conversationId: string | null; tabs: BrowserTab[] }

// What a connection watching every tab puts in its browsing set.
export const WATCH_ALL = '*'

function mayBrowse(connection: Connection, tab: Pick<BrowserTab, 'conversationId'>): boolean {
  return connection.browsing.has(WATCH_ALL) || (tab.conversationId !== null && connection.browsing.has(tab.conversationId))
}

// Asks the user, in the conversation's chat, about a site the browser is to open. Resolves with
// their decision; rejects when there is no chat to ask in or the question was dropped.
export type HostAsk = (conversationId: string, host: string, url: string) => Promise<ChatDecision>

type ActionParams<K extends keyof typeof browserActions> = z.output<(typeof browserActions)[K]>
type BrowserPaths = Pick<KandoPaths, 'browserHostFile'>

// A host that does not answer a status request this fast is hung.
const STATUS_TIMEOUT_MS = 5_000
// After the user's last input on a tab, the agent's calls on it are refused for this long.
const DRIVING_MS = 5_000
const MAX_SNAPSHOT_CHARS = 60_000

const APP_CLOSED: BrowserStatus = { state: 'app-closed', running: false }
const APP_CLOSED_TEXT = '浏览器在 Kando 应用里运行，请打开 Kando 应用后再试'

function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms)
    timer.unref()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

// Kando's browser, as core sees it: the host the desktop app runs for it, the tabs it has, which
// conversation each belongs to, and what the user has allowed each conversation to open. Every
// agent call names its conversation and reaches only that conversation's tabs. The app says
// where its host listens through the host file; with no app up there is no browser.
export class BrowserService {
  private link: HostLink | null = null
  private starting: Promise<HostLink> | null = null
  private statusValue: BrowserStatus = APP_CLOSED
  private tabs = new Map<string, HostTab>()
  private readonly allowed = new Map<string, Set<string>>()
  // Allowed once, for a navigation the host had already given up on when the answer came.
  private readonly allowOnce = new Map<string, Set<string>>()
  private readonly drivingUntil = new Map<string, number>()
  private readonly drivingTimers = new Map<string, NodeJS.Timeout>()
  private readonly acting = new Set<string>()

  constructor(
    private readonly paths: BrowserPaths,
    private readonly attachments: Pick<AttachmentStore, 'put'>,
    private readonly askHost: HostAsk,
    private readonly emit: (event: BrowserEvent) => void,
    private readonly connect: HostConnect = connectBrowserHost,
    private readonly now: () => number = Date.now
  ) {}

  // ---- the app's host

  // The host file may have changed: an app came up, or went. Connects when none is; a link that
  // is up learns of the app going from its socket.
  hostFileChanged(): void {
    if (this.link || this.starting) return
    void this.ensureLink().catch(() => {})
  }

  private ensureLink(): Promise<HostLink> {
    if (this.link) return Promise.resolve(this.link)
    if (this.starting) return this.starting
    this.starting = this.connectHost().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async connectHost(): Promise<HostLink> {
    const endpoint = await readBrowserHostEndpoint(this.paths.browserHostFile)
    if (!endpoint) {
      this.noteClosed()
      throw new Rejection('browser-app-closed', APP_CLOSED_TEXT)
    }
    if (endpoint.protocolVersion !== BROWSER_HOST_PROTOCOL_VERSION) {
      throw new Rejection('browser-app-outdated', `Kando 应用的浏览器是版本 ${endpoint.protocolVersion}，core 需要 ${BROWSER_HOST_PROTOCOL_VERSION}：请把应用和 core 一起升级`)
    }
    this.setStatus({ state: 'starting', running: false })
    let link: HostLink
    try {
      link = await this.connect(endpoint)
    } catch (error) {
      // A file left by an app that crashed names a port nothing answers on.
      this.noteClosed()
      throw error instanceof Rejection ? new Rejection('browser-app-closed', APP_CLOSED_TEXT) : error
    }
    link.onEvent((event) => this.handleHostEvent(link, event))
    link.onClose(() => this.hostGone(link))
    this.link = link
    try {
      const status = await withTimeout(link.request('status', {}), STATUS_TIMEOUT_MS, () => new Rejection('browser-unavailable', '浏览器宿主没有响应'))
      this.setStatus({ ...status, running: true })
      this.setTabs((await link.request('tabs.list', {})).tabs)
    } catch (error) {
      link.close()
      this.hostGone(link)
      throw error
    }
    return link
  }

  private noteClosed(): void {
    if (this.statusValue.state !== 'app-closed') this.setStatus(APP_CLOSED)
  }

  private hostGone(link: HostLink): void {
    if (this.link !== link) return
    this.link = null
    link.close()
    for (const timer of this.drivingTimers.values()) clearTimeout(timer)
    this.drivingTimers.clear()
    this.drivingUntil.clear()
    this.acting.clear()
    const owners = new Set([...this.tabs.values()].map((tab) => tab.conversationId))
    this.tabs = new Map()
    for (const conversationId of owners) this.emitTabs(conversationId)
    this.setStatus(APP_CLOSED)
  }

  private handleHostEvent(link: HostLink, event: BrowserHostEvent): void {
    if (this.link !== link) return
    switch (event.event) {
      case 'status':
        this.setStatus({ ...event.status, running: true })
        return
      case 'tabs':
        this.setTabs(event.tabs)
        return
      case 'hostCheck':
        void this.hostCheck(link, event)
    }
  }

  private setStatus(status: BrowserStatus): void {
    this.statusValue = status
    this.emit({ type: 'status', status })
  }

  private setTabs(tabs: readonly HostTab[]): void {
    const touched = new Set([...this.tabs.values()].map((tab) => tab.conversationId))
    const gone = [...this.tabs.keys()].filter((id) => !tabs.some((tab) => tab.id === id))
    this.tabs = new Map(tabs.map((tab) => [tab.id, tab]))
    for (const id of gone) this.stopDriving(id)
    for (const tab of tabs) touched.add(tab.conversationId)
    for (const conversationId of touched) this.emitTabs(conversationId)
  }

  private emitTabs(conversationId: string | null): void {
    this.emit({ type: 'tabs', conversationId, tabs: this.tabsOf(conversationId) })
  }

  // ---- the site gate

  // The host met a top-level navigation it has no say over (a link the agent or user clicked, a
  // redirect): it is cleared the same way an agent's own navigation is, within the host's wait.
  private async hostCheck(link: HostLink, check: Extract<BrowserHostEvent, { event: 'hostCheck' }>): Promise<void> {
    const outcome = await this.permit(check.conversationId, check.tabId, check.host, check.url)
    if (outcome === 'done' && check.conversationId !== null) this.allowOnce.get(check.conversationId)?.delete(check.host)
    await link.request('host.resolve', { checkId: check.checkId, allow: outcome === 'done' }).catch(() => {})
  }

  // Whether the conversation may open the site now: by what the user allowed before, by the user
  // being at the wheel themselves, or by asking them. An answer that comes after the wait still
  // counts: for the conversation, or for the agent's next try at the site.
  private async permit(conversationId: string | null, tabId: string | null, hostName: string, url: string): Promise<BrowserNavigation['outcome']> {
    if (isLocalHost(hostName)) return 'done'
    // The user's own tab goes where the user takes it.
    if (conversationId === null) return 'done'
    if (this.allowed.get(conversationId)?.has(hostName) || this.allowOnce.get(conversationId)?.has(hostName)) return 'done'
    if (tabId && this.isDriving(tabId)) return 'done'
    // Asking can fail at once (no chat is running to ask in): that is a refusal, not a crash.
    const asked = Promise.resolve().then(() => this.askHost(conversationId, hostName, url)).then(
      (decision) => {
        if (decision === 'allowForSession') this.remember(this.allowed, conversationId, hostName)
        else if (decision === 'allow') this.remember(this.allowOnce, conversationId, hostName)
        return decision
      },
      (): ChatDecision => 'deny'
    )
    const decision = await Promise.race([asked, new Promise<null>((resolve) => setTimeout(() => resolve(null), BROWSER_HOST_DECISION_WAIT_MS).unref())])
    if (decision === null) return 'awaiting-host'
    return decision === 'deny' ? 'denied' : 'done'
  }

  private remember(map: Map<string, Set<string>>, conversationId: string, host: string): void {
    const hosts = map.get(conversationId) ?? new Set<string>()
    hosts.add(host)
    map.set(conversationId, hosts)
  }

  // ---- what the app asks

  async status(): Promise<BrowserStatus> {
    try {
      await this.ensureLink()
    } catch (error) {
      if (!(error instanceof Rejection)) throw error
      return { ...this.statusValue, running: false, message: error.message }
    }
    return this.statusValue
  }

  watch(connection: Connection, conversationId: string): BrowserTab[] {
    connection.browsing.add(conversationId)
    return this.tabsOf(conversationId)
  }

  unwatch(connection: Connection, conversationId: string): void {
    connection.browsing.delete(conversationId)
  }

  watchAll(connection: Connection): BrowserTab[] {
    connection.browsing.add(WATCH_ALL)
    return this.allTabs()
  }

  unwatchAll(connection: Connection): void {
    connection.browsing.delete(WATCH_ALL)
  }

  allTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => this.describe(tab))
  }

  async userNavigate(connection: Connection, tabId: string, to: BrowserNavigateTo): Promise<BrowserTab> {
    const link = await this.userTab(connection, tabId)
    this.markDriving(tabId)
    return this.describe((await link.request('navigate', { tabId, to })).tab)
  }

  async newTab(connection: Connection, conversationId: string | null, url: string | undefined): Promise<BrowserTab> {
    if (!mayBrowse(connection, { conversationId })) throw new Rejection('browser-not-watching', 'watch the conversation first')
    const link = await this.ensureLink()
    const opened = await link.request('tabs.open', { ...(conversationId ? { conversationId } : {}), ...(url ? { url } : {}) })
    this.markDriving(opened.tab.id)
    return this.describe(opened.tab)
  }

  async closeTab(connection: Connection, tabId: string): Promise<void> {
    const link = await this.userTab(connection, tabId)
    await link.request('tabs.close', { tabId })
  }

  handBack(connection: Connection, tabId: string): void {
    this.checkWatching(connection, tabId)
    this.stopDriving(tabId)
  }

  // The panel's size presets: the tab held at one, or following the panel again.
  async userViewport(connection: Connection, tabId: string, viewport: BrowserViewport | null): Promise<BrowserTab> {
    const link = await this.userTab(connection, tabId)
    await link.request('viewport', { tabId, viewport })
    return this.describe({ ...this.checkWatching(connection, tabId), viewport })
  }

  async userScreenshot(connection: Connection, tabId: string): Promise<AttachmentInfo> {
    const link = await this.userTab(connection, tabId)
    const shot = await link.request('screenshot', { tabId })
    return this.attachments.put(Buffer.from(shot.jpeg, 'base64'))
  }

  private checkWatching(connection: Connection, tabId: string): HostTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Rejection('browser-tab-not-found', '标签页已经关闭')
    if (!mayBrowse(connection, tab)) throw new Rejection('browser-not-watching', 'watch the conversation first')
    return tab
  }

  private userTab(connection: Connection, tabId: string): Promise<HostLink> {
    this.checkWatching(connection, tabId)
    return this.ensureLink()
  }

  private markDriving(tabId: string): void {
    const was = this.isDriving(tabId)
    this.drivingUntil.set(tabId, this.now() + DRIVING_MS)
    const earlier = this.drivingTimers.get(tabId)
    if (earlier) clearTimeout(earlier)
    const timer = setTimeout(() => this.stopDriving(tabId), DRIVING_MS)
    timer.unref()
    this.drivingTimers.set(tabId, timer)
    if (!was) this.tabChanged(tabId)
  }

  private stopDriving(tabId: string): void {
    const timer = this.drivingTimers.get(tabId)
    if (timer) clearTimeout(timer)
    this.drivingTimers.delete(tabId)
    const was = this.isDriving(tabId)
    this.drivingUntil.delete(tabId)
    if (was) this.tabChanged(tabId)
  }

  private isDriving(tabId: string): boolean {
    return (this.drivingUntil.get(tabId) ?? 0) > this.now()
  }

  private tabChanged(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) this.emitTabs(tab.conversationId)
  }

  // ---- what an agent asks, for its conversation

  tabsOf(conversationId: string | null): BrowserTab[] {
    return [...this.tabs.values()].filter((tab) => tab.conversationId === conversationId).map((tab) => this.describe(tab))
  }

  tabOf(tabId: string): BrowserTab | null {
    const tab = this.tabs.get(tabId)
    return tab ? this.describe(tab) : null
  }

  async open(conversationId: string, url?: string, viewport?: BrowserViewport | null): Promise<BrowserNavigation> {
    const link = await this.ensureLink()
    const opened = await link.request('tabs.open', { conversationId, ...(viewport !== undefined ? { viewport } : {}) })
    this.tabs.set(opened.tab.id, opened.tab)
    return url ? this.navigate(conversationId, opened.tab.id, { url }) : this.navigation(opened)
  }

  // The site is cleared with the user before the page moves, so a refusal leaves the page as it
  // was rather than on an error page. A viewport given holds the tab at it from here on.
  async navigate(conversationId: string, tabId: string, to: BrowserNavigateTo, viewport?: BrowserViewport | null): Promise<BrowserNavigation> {
    const link = await this.agentTab(conversationId, tabId)
    return this.whileActing(tabId, async () => {
      const target = 'url' in to ? to.url : null
      const hostName = target === null ? null : browserHostOf(target)
      if (hostName && target !== null) {
        const outcome = await this.permit(conversationId, tabId, hostName, target)
        if (outcome !== 'done') {
          const tab = this.tabs.get(tabId)
          if (!tab) throw new Rejection('browser-tab-not-found', '标签页不存在，先用 browser_tabs 看一下')
          return { tab, outcome, snapshot: null }
        }
      }
      return link.request('navigate', { tabId, to, ...(viewport !== undefined ? { viewport } : {}) })
    }, (result) => this.navigation(result))
  }

  // Holds the tab at a size for the agent's layout, or lets it follow the panel again.
  async setViewport(conversationId: string, tabId: string, viewport: BrowserViewport | null): Promise<BrowserTab> {
    const link = await this.agentTab(conversationId, tabId)
    return this.whileActing(tabId, async () => {
      await link.request('viewport', { tabId, viewport })
      return this.tabs.get(tabId)
    }, (tab) => {
      if (!tab) throw new Rejection('browser-tab-not-found', '标签页不存在，先用 browser_tabs 看一下')
      return this.describe({ ...tab, viewport })
    })
  }

  snapshot(conversationId: string, tabId: string): Promise<BrowserAction> {
    return this.action(conversationId, 'snapshot', { tabId })
  }

  click(conversationId: string, tabId: string, params: ActionParams<'click'>): Promise<BrowserAction> {
    return this.action(conversationId, 'click', { tabId, ...params })
  }

  type(conversationId: string, tabId: string, params: ActionParams<'type'>): Promise<BrowserAction> {
    return this.action(conversationId, 'type', { tabId, ...params })
  }

  press(conversationId: string, tabId: string, params: ActionParams<'press'>): Promise<BrowserAction> {
    return this.action(conversationId, 'press', { tabId, ...params })
  }

  hover(conversationId: string, tabId: string, params: ActionParams<'hover'>): Promise<BrowserAction> {
    return this.action(conversationId, 'hover', { tabId, ...params })
  }

  scroll(conversationId: string, tabId: string, params: ActionParams<'scroll'>): Promise<BrowserAction> {
    return this.action(conversationId, 'scroll', { tabId, ...params })
  }

  select(conversationId: string, tabId: string, params: ActionParams<'select'>): Promise<BrowserAction> {
    return this.action(conversationId, 'select', { tabId, ...params })
  }

  wait(conversationId: string, tabId: string, params: ActionParams<'wait'>): Promise<BrowserAction> {
    return this.action(conversationId, 'wait', { tabId, ...params })
  }

  async screenshot(conversationId: string, tabId: string, options: { fullPage?: boolean; ref?: string }): Promise<BrowserScreenshot> {
    const link = await this.agentTab(conversationId, tabId)
    return this.whileActing(tabId, async () => {
      const shot = await link.request('screenshot', { tabId, ...options })
      const info = await this.attachments.put(Buffer.from(shot.jpeg, 'base64'))
      return { tab: shot.tab, image: { id: info.id, width: info.width, height: info.height } }
    }, (shot) => ({ tab: this.describe(shot.tab), image: shot.image }))
  }

  async console(conversationId: string, tabId: string, sinceNavigation: boolean): Promise<BrowserConsole> {
    const link = await this.agentTab(conversationId, tabId)
    return link.request('console', { tabId, sinceNavigation })
  }

  async close(conversationId: string, tabId: string): Promise<void> {
    const link = await this.agentTab(conversationId, tabId)
    await link.request('tabs.close', { tabId })
  }

  // A conversation deleted takes its tabs and what it was allowed with it.
  async closeForConversation(conversationId: string): Promise<void> {
    this.allowed.delete(conversationId)
    this.allowOnce.delete(conversationId)
    const link = this.link
    if (link && this.tabsOf(conversationId).length) await link.request('tabs.closeAll', { conversationId }).catch(() => {})
  }

  private async action<M extends 'snapshot' | keyof typeof browserActions>(conversationId: string, method: M, params: BrowserHostParams<M>): Promise<BrowserAction> {
    const link = await this.agentTab(conversationId, params.tabId)
    return this.whileActing(params.tabId, () => link.request(method, params), (result) => ({ tab: this.describe(result.tab), snapshot: clip(result.snapshot, MAX_SNAPSHOT_CHARS) }))
  }

  private agentTab(conversationId: string, tabId: string): Promise<HostLink> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.conversationId !== conversationId) throw new Rejection('browser-tab-not-found', '标签页不存在，先用 browser_tabs 看一下')
    if (this.isDriving(tabId)) throw new Rejection('browser-user-driving', '用户正在操作这个标签页，请等待，或向用户确认再继续')
    return this.ensureLink()
  }

  // The tab reads as the agent's while the call runs; the result describes it once it is done.
  private async whileActing<T, R>(tabId: string, run: () => Promise<T>, finish: (result: T) => R): Promise<R> {
    this.acting.add(tabId)
    this.tabChanged(tabId)
    let result: T
    try {
      result = await run()
    } finally {
      this.acting.delete(tabId)
      this.tabChanged(tabId)
    }
    return finish(result)
  }

  private navigation(result: { tab: HostTab; outcome: BrowserNavigation['outcome']; snapshot: string | null }): BrowserNavigation {
    return { tab: this.describe(result.tab), outcome: result.outcome, snapshot: result.snapshot === null ? null : clip(result.snapshot, MAX_SNAPSHOT_CHARS) }
  }

  private describe(tab: HostTab): BrowserTab {
    return { ...tab, userDriving: this.isDriving(tab.id), agentActing: this.acting.has(tab.id) }
  }
}
