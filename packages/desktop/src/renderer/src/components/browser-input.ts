import type { BrowserInputEvent } from '@kando/protocol'

// The live view's input, turned into what the browser host hands CDP: pure functions, so the
// mapping of a click or a key can be checked without a page.

export type Viewport = { width: number; height: number }
export type Box = { left: number; top: number; width: number; height: number }

// Where the viewport sits inside the box it is drawn in, letterboxed to fit, and at what scale.
export function frameFit(box: Box, viewport: Viewport): { offsetX: number; offsetY: number; scale: number } {
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height)
  const width = viewport.width * scale
  const height = viewport.height * scale
  return { offsetX: box.left + (box.width - width) / 2, offsetY: box.top + (box.height - height) / 2, scale }
}

// A point in the window, as the tab's own CSS pixels; null outside the drawn page.
export function toTabPoint(clientX: number, clientY: number, box: Box, viewport: Viewport): { x: number; y: number } | null {
  const fit = frameFit(box, viewport)
  if (fit.scale <= 0) return null
  const x = (clientX - fit.offsetX) / fit.scale
  const y = (clientY - fit.offsetY) / fit.scale
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }
}

type ModifierKeys = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

// CDP's bitmask: Alt 1, Control 2, Meta 4, Shift 8.
export function modifiersOf(event: ModifierKeys): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

export function mouseButtonOf(button: number): 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward' {
  switch (button) {
    case 0: return 'left'
    case 1: return 'middle'
    case 2: return 'right'
    case 3: return 'back'
    case 4: return 'forward'
    default: return 'none'
  }
}

type MouseLike = ModifierKeys & { button: number; buttons: number; detail: number }

export function mouseEvent(action: 'pressed' | 'released' | 'moved', event: MouseLike, point: { x: number; y: number }): BrowserInputEvent {
  return {
    type: 'mouse',
    action,
    x: point.x,
    y: point.y,
    button: action === 'moved' ? 'none' : mouseButtonOf(event.button),
    buttons: event.buttons & 31,
    clickCount: action === 'moved' ? 0 : Math.min(3, Math.max(1, event.detail)),
    modifiers: modifiersOf(event)
  }
}

type WheelLike = ModifierKeys & { deltaX: number; deltaY: number; deltaMode: number }
// A line of scrolling in pixels when the wheel counts lines (Firefox); a page is the viewport.
const LINE_PX = 16

export function wheelEvent(event: WheelLike, point: { x: number; y: number }, viewport: Viewport): BrowserInputEvent {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? viewport.height : 1
  return { type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiersOf(event) }
}

type KeyLike = ModifierKeys & { key: string; code: string; keyCode: number; isComposing: boolean }

// A key as the page should see it. Printable keys carry their character unless Control or Meta
// holds a shortcut; what an input method composes goes separately as text. Escape is the app's.
export function keyEvent(action: 'down' | 'up', event: KeyLike): BrowserInputEvent | null {
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Escape') return null
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
  return {
    type: 'key',
    action,
    key: event.key.slice(0, 32),
    code: event.code.slice(0, 64),
    windowsVirtualKeyCode: Math.min(255, Math.max(0, event.keyCode)),
    ...(printable && action === 'down' ? { text: event.key } : {}),
    modifiers: modifiersOf(event)
  }
}

// How large a frame the view asks for: enough for what it draws at the screen's density, in steps
// so a small drag does not restart the stream, and never past the page's own size.
const BUDGET_STEP = 160

export function frameBudget(displayWidth: number, displayHeight: number, devicePixelRatio: number, viewport: Viewport): { maxWidth: number; maxHeight: number } {
  const scale = Math.min(displayWidth / viewport.width, displayHeight / viewport.height) * Math.max(1, devicePixelRatio)
  const width = Math.min(viewport.width, Math.max(BUDGET_STEP, Math.ceil((viewport.width * scale) / BUDGET_STEP) * BUDGET_STEP))
  const height = Math.min(viewport.height, Math.round((width * viewport.height) / viewport.width))
  return { maxWidth: width, maxHeight: Math.max(100, height) }
}
