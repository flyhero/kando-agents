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
  setTheme: (theme: string): Promise<unknown> => ipcRenderer.invoke('kando:set-theme', theme)
})
