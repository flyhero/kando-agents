import { screen, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { POPUP_WIDTH, popupBounds, type Area } from './popup-placement'

// The card at the top of the screen with what agents wait on, for answering from another app.
// The main window's renderer asks for it when a request comes in while the user is away; the
// card's own renderer, a client of core like any window, says whether it has anything to show
// and how tall it is. Main only places the window: what is asked and answered is core's.
export class RequestPopup {
  private window: BrowserWindow | null = null
  private wanted = false
  // The display it came up on, kept while it shows so a new height does not move it.
  private area: Area | null = null

  constructor(private readonly create: () => BrowserWindow) {}

  // Asked for (a request came while the user was away) or put away (the user is back).
  want(wanted: boolean): void {
    this.wanted = wanted
    if (!wanted) this.hide()
    if (wanted && !this.window) {
      this.open()
      return
    }
    this.window?.webContents.send('kando:request-popup-wanted', wanted)
  }

  // The card's say: shown at its height, or put away with nothing left to show.
  layout(visible: boolean, height: number): void {
    const window = this.window
    if (!window) return
    // Down while it loads or between chats, it may still come up; once put away, a late word from
    // the card does not bring it back.
    if (!visible || !this.wanted) {
      this.hide()
      return
    }
    if (!this.area) this.area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    window.setBounds(popupBounds(this.area, height))
    // Never takes the keyboard from the app the user is in: a number key there must not answer.
    if (!window.isVisible()) window.showInactive()
  }

  owns(contents: WebContents): boolean {
    return this.window !== null && this.window.webContents === contents
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
    this.area = null
  }

  private hide(): void {
    this.area = null
    if (this.window?.isVisible()) this.window.hide()
  }

  private open(): void {
    const window = this.create()
    this.window = window
    // Above other apps' windows. On macOS a panel also floats over a full-screen app, on every
    // Space. Wayland lets no app place or raise its own window: there the card is a plain window
    // wherever the compositor puts it.
    if (process.platform === 'darwin') {
      window.setAlwaysOnTop(true, 'floating')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } else {
      window.setAlwaysOnTop(true)
    }
    window.webContents.on('did-finish-load', () => window.webContents.send('kando:request-popup-wanted', this.wanted))
    window.once('closed', () => {
      if (this.window === window) {
        this.window = null
        this.area = null
      }
    })
  }
}

// The window itself; the caller loads the page and keeps it from navigating.
export function popupWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: POPUP_WIDTH,
    height: 200,
    show: false,
    frame: false,
    // The card draws its own corners and shadow (styles.css), on a window that is clear around it.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Kando',
    // An NSPanel: floats over full-screen apps without bringing Kando's other windows forward.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
}
