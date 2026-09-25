import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, type OpenDialogOptions } from 'electron'
import { readCoreEndpoint } from '@kando/protocol/node'

// Main stays thin: tasks, git and PTYs live in core/daemon, so the window
// can close or crash without touching running agents.
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
