import type { BrowserFrame, BrowserTab, BrowserViewOptions } from '@kando/protocol'
import { Rejection } from './rejection'
import type { Connection } from './rpc-server'

// Frames a viewer may have unacknowledged. A viewer that falls behind (a hidden window, a pause)
// gets no more until it catches up, and then the newest, never a backlog.
export const FRAME_WINDOW = 2

export class FrameGate {
  private inFlight = 0
  private last = -1

  offer(seq: number): boolean {
    if (this.inFlight >= FRAME_WINDOW) return false
    this.inFlight += 1
    this.last = seq
    return true
  }

  ack(seq: number): void {
    if (seq > this.last) return
    this.inFlight = Math.max(0, this.inFlight - 1)
  }
}

export type Screencasts = {
  start(tabId: string, options: BrowserViewOptions): Promise<void>
  stop(tabId: string): Promise<void>
}

type View = { gate: FrameGate; release: () => void }

// Which connection views which tabs (the inspector and the browser panel may each show one), and
// the one screencast per tab that feeds every view of it.
export class BrowserViews {
  private readonly views = new Map<Connection, Map<string, View>>()
  private readonly viewers = new Map<string, number>()

  constructor(
    private readonly screencasts: () => Screencasts | null,
    private readonly tabOf: (tabId: string) => BrowserTab | null,
    private readonly mayView: (connection: Connection, tab: BrowserTab) => boolean
  ) {}

  async start(connection: Connection, tabId: string, options: BrowserViewOptions): Promise<void> {
    const tab = this.tabOf(tabId)
    if (!tab) throw new Rejection('browser-tab-not-found', '标签页不存在')
    if (!this.mayView(connection, tab)) throw new Rejection('browser-not-watching', 'watch the conversation first')
    const screencasts = this.screencasts()
    if (!screencasts) throw new Rejection('browser-unavailable', '浏览器没有运行')
    let own = this.views.get(connection)
    if (!own) {
      own = new Map()
      this.views.set(connection, own)
      connection.onClose(() => void this.stop(connection))
    }
    if (!own.has(tabId)) {
      own.set(tabId, { gate: new FrameGate(), release: () => {} })
      this.viewers.set(tabId, (this.viewers.get(tabId) ?? 0) + 1)
    }
    // The newest viewer's size wins; a restart with new bounds is harmless to the others.
    await screencasts.start(tabId, options)
  }

  // Ends one of the connection's views, or all of them.
  async stop(connection: Connection, tabId?: string): Promise<void> {
    const own = this.views.get(connection)
    if (!own) return
    const ending = tabId === undefined ? [...own.keys()] : own.has(tabId) ? [tabId] : []
    for (const each of ending) {
      own.delete(each)
      const left = (this.viewers.get(each) ?? 1) - 1
      if (left > 0) {
        this.viewers.set(each, left)
      } else {
        this.viewers.delete(each)
        await this.screencasts()?.stop(each).catch(() => {})
      }
    }
    if (own.size === 0) this.views.delete(connection)
  }

  ack(connection: Connection, tabId: string, seq: number): void {
    this.views.get(connection)?.get(tabId)?.gate.ack(seq)
  }

  handleFrame(frame: BrowserFrame): void {
    for (const [connection, own] of this.views) {
      const view = own.get(frame.tabId)
      if (view?.gate.offer(frame.seq)) connection.notify('browser.frame', frame)
    }
  }

  // The tab is gone, or the host with it: its viewers are left to the panel's empty state.
  tabClosed(tabId: string): void {
    for (const [connection, own] of [...this.views]) {
      own.delete(tabId)
      if (own.size === 0) this.views.delete(connection)
    }
    this.viewers.delete(tabId)
  }

  closeAll(): void {
    for (const tabId of [...this.viewers.keys()]) this.tabClosed(tabId)
  }
}
