import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, protocol, shell, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { kandoPaths, readCoreEndpoint } from '@kando/protocol/node'
import { ensureBackend } from './backend'
import { startBrowserHost, type BrowserHost } from './browser/browser-host'
import { WindowSlot } from './browser/window-slot'

// The built-in browser: its tabs live here, in main, so a window closing or its renderer going
// never touches a page an agent is on. The slot puts the one on show into the current window.
const slot = new WindowSlot()
let browserHost: BrowserHost | null = null

// Files an agent wrote, served to the preview frames in the chat: kando-preview://file/<path>.
// Registered before the app is ready, as a standard scheme so relative links inside a page resolve.
const PREVIEW_SCHEME = 'kando-preview'
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

const PREVIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}
// The page may style itself and run its own scripts, but reach nothing else: no network, no other
// frames, no forms, no parent. The renderer's sandbox on the frame keeps it off the app too. The
// frame has no origin of its own (sandboxed), so its files are named by scheme rather than 'self'.
const PREVIEW_POLICY = [
  "default-src 'none'", `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`, `img-src ${PREVIEW_SCHEME}: data: blob:`, `font-src ${PREVIEW_SCHEME}: data:`,
  `script-src ${PREVIEW_SCHEME}: 'unsafe-inline'`, `media-src ${PREVIEW_SCHEME}: data: blob:`, "connect-src 'none'", "frame-src 'none'",
  "base-uri 'none'", "form-action 'none'"
].join('; ')

async function servePreview(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)
  if (url.host !== 'file' || !isAbsolute(path)) return new Response('not found', { status: 404 })
  try {
    // The path as it really is: a link may not lead the frame somewhere else under a page's name.
    const real = await realpath(path)
    const info = await stat(real)
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return new Response('not found', { status: 404 })
    const body = await readFile(real)
    const type = PREVIEW_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'
    return new Response(body, { headers: { 'content-type': type, 'content-security-policy': PREVIEW_POLICY, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

// Main stays thin: tasks, git and PTYs live in core/daemon, so the window
// can close or crash without touching running agents. Browser tabs are the one exception, and
// they are kept apart from the window for the same reason.
function createWindow(): void {
  // On macOS the sidebar and pane headers take the title bar's place; the renderer
  // mirrors this check (desktop-bridge applyTitleBar) to lay out around the lights.
  const insetTitleBar = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Kando',
    titleBarStyle: insetTitleBar ? 'hidden' : 'default',
    trafficLightPosition: insetTitleBar ? { x: 20, y: 19 } : undefined,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  if (insetTitleBar) {
    // Fullscreen hides the traffic lights, so the renderer drops the space kept for them.
    // Resent on every load so a reload while fullscreen keeps the right layout.
    const sendFullScreen = () => win.webContents.send('kando:full-screen', win.isFullScreen())
    win.on('enter-full-screen', sendFullScreen)
    win.on('leave-full-screen', sendFullScreen)
    win.webContents.on('did-finish-load', sendFullScreen)
  }
  // A file dropped outside a drop target would otherwise replace the app with that file.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
    }
  })
  // A link in a reply: a web page goes to the browser (a dev server's http:// too); nothing else
  // may open a window, or start an app through its scheme.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  slot.attachWindow(win)
}

// The browser panel's say over the tab on show: which one, where it sits, whether something is
// over it. Bounds arrive as the renderer's CSS pixels; the window's zoom turns them into points.
const Bounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) })
ipcMain.handle('kando:browser-show', (_event, tabId: unknown) => {
  const id = typeof tabId === 'string' ? tabId : null
  slot.show(id, id ? (browserHost?.viewOf(id) ?? null) : null, id ? (browserHost?.viewportOf(id) ?? null) : null)
})
ipcMain.on('kando:browser-bounds', (event, bounds: unknown) => {
  const parsed = Bounds.safeParse(bounds)
  if (!parsed.success) return
  const zoom = event.sender.getZoomFactor()
  const { x, y, width, height } = parsed.data
  slot.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) })
})
ipcMain.handle('kando:browser-occluded', (_event, occluded: unknown) => {
  slot.setOccluded(occluded === true)
})

// Re-read on every call: core rewrites the file with a new port/token on restart.
ipcMain.handle('kando:core-endpoint', () => readCoreEndpoint())

// Drives prefers-color-scheme in every window and the native chrome with it.
ipcMain.handle('kando:set-theme', (_event, theme: unknown) => {
  if (theme === 'system' || theme === 'light' || theme === 'dark') {
    nativeTheme.themeSource = theme
  }
})

ipcMain.handle('kando:pick-folder', async (event, defaultPath: unknown) => {
  const options: OpenDialogOptions = {
    title: '选择代码仓库',
    properties: ['openDirectory'],
    defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// Shows a file a reply names in the system's file manager: the first of the paths the renderer
// resolved it to that exists. Showing never opens or runs it, so a path an agent wrote cannot start
// anything.
ipcMain.handle('kando:reveal-file', async (_event, candidates: unknown) => {
  if (!Array.isArray(candidates)) return null
  for (const candidate of candidates.slice(0, 20)) {
    if (typeof candidate !== 'string') continue
    const path = candidate === '~' || candidate.startsWith('~/') ? join(homedir(), candidate.slice(1)) : candidate
    if (!isAbsolute(path)) continue
    try {
      await stat(path)
    } catch {
      continue
    }
    shell.showItemInFolder(path)
    return path
  }
  return null
})

ipcMain.handle('kando:open-file', async (_event, file: unknown) => {
  if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) return '文件路径无效'
  try {
    const info = await stat(file)
    if (!info.isFile() && !info.isDirectory()) return '不支持打开此文件'
    return await shell.openPath(file)
  } catch {
    return `无法打开文件：${file}`
  }
})

// What the renderer says and where a click leads; the target is handed back as it came.
const Notice = z.object({ title: z.string().max(200), body: z.string().max(1000), target: z.unknown() })

// A system notification from the renderer, which decides what is worth one; clicking it brings
// the window up and tells the renderer where to go. Main only relays: what is said is the
// renderer's, so an older or newer renderer changes nothing here.
ipcMain.handle('kando:notify', (event, notice: unknown) => {
  const parsed = Notice.safeParse(notice)
  if (!Notification.isSupported() || !parsed.success) return false
  const { title, body, target } = parsed.data
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('kando:notification-click', target)
  })
  notification.show()
  return true
})

// How many things wait on the user, on the dock icon (macOS) or launcher (Linux). Windows shows
// no count without an overlay icon, which this does not draw.
ipcMain.handle('kando:set-badge', (_event, count: unknown) => {
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0) app.setBadgeCount(count)
})

// Packaged, a second launch would race the first for daemon and core; hand it to the open window.
const primary = !app.isPackaged || app.requestSingleInstanceLock()
if (!primary) {
  app.quit()
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

void app.whenReady().then(() => {
  if (!primary) return
  protocol.handle(PREVIEW_SCHEME, servePreview)
  void ensureBackend()
  createWindow()
  startBrowserHost(slot, kandoPaths().browserHostFile).then(
    (host) => { browserHost = host },
    (error: unknown) => console.error('[kando] the browser host did not start', error)
  )
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// The tabs go with the app, and the host file with them, so core sees the browser as closed
// rather than finding a port nothing answers on.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !browserHost) return
  event.preventDefault()
  quitting = true
  void browserHost.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
