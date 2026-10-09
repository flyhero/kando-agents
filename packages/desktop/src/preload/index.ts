import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('kando', {
  platform: process.platform,
  onFullScreenChange: (listener: (fullScreen: boolean) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, fullScreen: unknown) => listener(fullScreen === true)
    ipcRenderer.on('kando:full-screen', handler)
    return () => ipcRenderer.removeListener('kando:full-screen', handler)
  },
  getCoreEndpoint: (): Promise<unknown> => ipcRenderer.invoke('kando:core-endpoint'),
  pickFolder: (defaultPath?: string): Promise<unknown> => ipcRenderer.invoke('kando:pick-folder', defaultPath),
  setTheme: (theme: string): Promise<unknown> => ipcRenderer.invoke('kando:set-theme', theme),
  revealFile: (candidates: string[]): Promise<unknown> => ipcRenderer.invoke('kando:reveal-file', candidates),
  openFile: (path: string): Promise<unknown> => ipcRenderer.invoke('kando:open-file', path),
  notify: (notice: unknown): Promise<unknown> => ipcRenderer.invoke('kando:notify', notice),
  setBadge: (count: number): Promise<unknown> => ipcRenderer.invoke('kando:set-badge', count),
  onNotificationClick: (listener: (target: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, target: unknown) => listener(target)
    ipcRenderer.on('kando:notification-click', handler)
    return () => ipcRenderer.removeListener('kando:notification-click', handler)
  },
  // The built-in browser's tab on show, placed over the panel by main.
  browserShow: (tabId: string | null): Promise<unknown> => ipcRenderer.invoke('kando:browser-show', tabId),
  browserBounds: (bounds: { x: number; y: number; width: number; height: number }): void => ipcRenderer.send('kando:browser-bounds', bounds),
  browserOccluded: (occluded: boolean): Promise<unknown> => ipcRenderer.invoke('kando:browser-occluded', occluded),
  onBrowserFocused: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on('kando:browser-focused', handler)
    return () => ipcRenderer.removeListener('kando:browser-focused', handler)
  },
  onBrowserShortcut: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on('kando:browser-shortcut', handler)
    return () => ipcRenderer.removeListener('kando:browser-shortcut', handler)
  }
})
