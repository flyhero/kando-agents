import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { BrowserViewport } from '@kando/protocol'
import { fitViewport } from './viewport'

// Where the one tab on show sits: in the window, over the panel's rectangle. The renderer says
// which tab and where; a dialog or menu over the panel takes the view down meanwhile (occluded),
// and a window closing on macOS takes it down until the next one opens. The tabs themselves
// live on regardless: the view is only ever added to or removed from a window here.
export class WindowSlot {
  private window: BrowserWindow | null = null
  private shown: { tabId: string; view: WebContentsView; viewport: BrowserViewport | null } | null = null
  private bounds: Rectangle | null = null
  private occluded = false

  attachWindow(window: BrowserWindow): void {
    if (this.window === window) return
    this.takeDown()
    this.window = window
    window.once('closed', () => {
      if (this.window === window) {
        this.window = null
        this.shown = this.shown && { ...this.shown }
      }
    })
    this.place()
  }

  // The renderer's choice of tab, or none; null bounds keep the last rectangle until a new one.
  show(tabId: string | null, view: WebContentsView | null, viewport: BrowserViewport | null): void {
    if (this.shown && (!view || this.shown.view !== view)) this.takeDown()
    this.shown = tabId && view ? { tabId, view, viewport } : null
    this.place()
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = bounds
    this.place()
  }

  setViewport(tabId: string, viewport: BrowserViewport | null): void {
    if (this.shown?.tabId === tabId) {
      this.shown.viewport = viewport
      this.place()
    }
  }

  setOccluded(occluded: boolean): void {
    if (this.occluded === occluded) return
    this.occluded = occluded
    if (occluded) this.takeDown()
    else this.place()
  }

  // The tab went: nothing to show until the renderer picks another.
  tabClosed(tabId: string): void {
    if (this.shown?.tabId === tabId) {
      this.takeDown()
      this.shown = null
    }
  }

  shownTabId(): string | null {
    return this.shown?.tabId ?? null
  }

  sendToRenderer(channel: string, payload: unknown): void {
    this.window?.webContents.send(channel, payload)
  }

  focusApp(): void {
    this.window?.webContents.focus()
  }

  private place(): void {
    const { window, shown, bounds } = this
    if (!window || window.isDestroyed() || !shown || !bounds || this.occluded) return
    if (!window.contentView.children.includes(shown.view)) window.contentView.addChildView(shown.view)
    shown.view.setBounds(fitViewport(bounds, shown.viewport))
  }

  private takeDown(): void {
    const { window, shown } = this
    if (!window || window.isDestroyed() || !shown) return
    if (window.contentView.children.includes(shown.view)) window.contentView.removeChildView(shown.view)
  }
}
