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

// Without the bridge (plain browser) the page still themes itself via data-theme.
export function setNativeTheme(theme: 'system' | 'light' | 'dark'): void {
  void window.kando?.setTheme(theme).catch(() => {})
}
