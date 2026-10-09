import { z } from 'zod'
import type { Notice } from './attention'

// What the Electron preload exposes; absent when the UI runs in a plain browser.
declare global {
  interface Window {
    kando?: {
      platform: string
      onFullScreenChange(listener: (fullScreen: boolean) => void): () => void
      getCoreEndpoint(): Promise<unknown>
      pickFolder(defaultPath?: string): Promise<unknown>
      setTheme(theme: string): Promise<unknown>
      // Absent from a main older than the renderer.
      revealFile?(candidates: string[]): Promise<unknown>
      openFile?(path: string): Promise<unknown>
      notify?(notice: unknown): Promise<unknown>
      setBadge?(count: number): Promise<unknown>
      onNotificationClick?(listener: (target: unknown) => void): () => void
      // The built-in browser's tab on show, a native view main places over the panel.
      browserShow?(tabId: string | null): Promise<unknown>
      browserBounds?(bounds: { x: number; y: number; width: number; height: number }): void
      browserOccluded?(occluded: boolean): Promise<unknown>
      onBrowserFocused?(listener: (event: unknown) => void): () => void
      onBrowserShortcut?(listener: (event: unknown) => void): () => void
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

export function canRevealFile(): boolean {
  return window.kando?.revealFile !== undefined
}

export function canOpenFile(): boolean {
  return window.kando?.openFile !== undefined
}

export async function openFile(path: string): Promise<string | null> {
  const error = await window.kando?.openFile?.(path)
  return typeof error === 'string' ? error || null : '当前客户端不支持系统打开'
}

// Shows the first of the paths that exists in the system's file manager; which one, or null.
export async function revealFile(candidates: readonly string[]): Promise<string | null> {
  const shown = await window.kando?.revealFile?.([...candidates])
  return typeof shown === 'string' ? shown : null
}

// Whether main can show notifications and count on the dock icon: in Electron, and one new enough.
export function canNotify(): boolean {
  return window.kando?.notify !== undefined && window.kando.setBadge !== undefined && window.kando.onNotificationClick !== undefined
}

export function notify(notice: Notice): void {
  void window.kando?.notify?.(notice).catch(() => {})
}

export function setBadge(count: number): void {
  void window.kando?.setBadge?.(count).catch(() => {})
}

const Target = z.union([z.object({ kind: z.enum(['task', 'conversation']), id: z.string() }), z.object({ kind: z.literal('routines') })])

// Main hands back the target the renderer gave it; only a well-formed one is acted on.
export function onNotificationClick(listener: (target: Notice['target']) => void): () => void {
  return (
    window.kando?.onNotificationClick?.((target) => {
      const parsed = Target.safeParse(target)
      if (parsed.success) listener(parsed.data)
    }) ?? (() => {})
  )
}

// Whether main shows browser tabs natively: in Electron, and one new enough.
export function canShowNativeBrowser(): boolean {
  return window.kando?.browserShow !== undefined
}

// Which tab main puts over the panel; null takes it down.
export function showNativeBrowserTab(tabId: string | null): void {
  void window.kando?.browserShow?.(tabId).catch(() => {})
}

// Where the panel's stage is, in CSS pixels, for main to place the view.
export function reportBrowserBounds(rect: { x: number; y: number; width: number; height: number }): void {
  window.kando?.browserBounds?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

export function setBrowserOccluded(occluded: boolean): void {
  void window.kando?.browserOccluded?.(occluded).catch(() => {})
}

const Focused = z.object({ tabId: z.string(), focused: z.boolean() })

// The native view taking or losing the keyboard, so the panel can say where keys go.
export function onBrowserFocused(listener: (tabId: string, focused: boolean) => void): () => void {
  return (
    window.kando?.onBrowserFocused?.((event) => {
      const parsed = Focused.safeParse(event)
      if (parsed.success) listener(parsed.data.tabId, parsed.data.focused)
    }) ?? (() => {})
  )
}

const Shortcut = z.object({ kind: z.enum(['toggle-browser', 'settings']) })

// An app shortcut pressed while a page had the keyboard; main caught it and passes it on.
export function onBrowserShortcut(listener: (kind: 'toggle-browser' | 'settings') => void): () => void {
  return (
    window.kando?.onBrowserShortcut?.((event) => {
      const parsed = Shortcut.safeParse(event)
      if (parsed.success) listener(parsed.data.kind)
    }) ?? (() => {})
  )
}

// Without the bridge (plain browser) the page still themes itself via data-theme.
export function setNativeTheme(theme: 'system' | 'light' | 'dark'): void {
  void window.kando?.setTheme(theme).catch(() => {})
}
