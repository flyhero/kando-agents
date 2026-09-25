// What the Electron preload exposes; absent when the UI runs in a plain browser.
declare global {
  interface Window {
    kando?: {
      platform: string
      onFullScreenChange(listener: (fullScreen: boolean) => void): () => void
      getCoreEndpoint(): Promise<unknown>
      pickFolder(defaultPath?: string): Promise<unknown>
      setTheme(theme: string): Promise<unknown>
    }
  }
}

// Mirrors main's titleBarStyle: macOS hides the title bar, so the page draws its own drag area.
export function applyTitleBar(): void {
  if (window.kando?.platform !== 'darwin') {
    return
  }
  const root = document.documentElement
  root.dataset.titlebar = 'inset'
  window.kando.onFullScreenChange((fullScreen) => {
    if (fullScreen) {
      root.dataset.fullscreen = ''
    } else {
      delete root.dataset.fullscreen
    }
  })
}

export function canPickFolder(): boolean {
  return window.kando !== undefined
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const picked = await window.kando?.pickFolder(defaultPath)
  return typeof picked === 'string' && picked !== '' ? picked : null
}

// Without the bridge (plain browser) the page still themes itself via data-theme.
export function setNativeTheme(theme: 'system' | 'light' | 'dark'): void {
  void window.kando?.setTheme(theme).catch(() => {})
}
