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
  }
})
