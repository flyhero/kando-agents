import type { BrowserInputEvent, RpcConnection } from '@kando/protocol'
import { base64ToBytes } from '../base64'
import { frameBudget, keyEvent, mouseEvent, toTabPoint, wheelEvent, type Viewport } from './browser-input'

// A frame's size is asked for again only when the panel changed enough to want another step.
const RESIZE_DEBOUNCE_MS = 300

// The live picture of one tab on a canvas, and the user's hands on it: frames arrive as
// notifications and are drawn as they come, each acknowledged once drawn so core sends the
// next; pointer and keyboard go the other way. The hidden textarea takes the keys, so the app's
// own shortcuts stay out of the page and an input method can compose.
export function createBrowserView(options: {
  canvas: HTMLCanvasElement
  textarea: HTMLTextAreaElement
  rpc: RpcConnection
  tabId: string
  viewport: Viewport
  onFocus(focused: boolean): void
}): { dispose(): void } {
  const { canvas, textarea, rpc, tabId, viewport } = options
  const context = canvas.getContext('2d')
  let disposed = false
  let drawing = false
  let latest: { seq: number; data: string } | null = null
  let budget = { maxWidth: 0, maxHeight: 0 }
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let moveFrame: number | null = null
  let pendingMove: BrowserInputEvent | null = null

  const send = (event: BrowserInputEvent) => {
    void rpc.call('browser.input', { tabId, event }).catch(() => {})
  }
  const flushMove = () => {
    if (pendingMove) send(pendingMove)
    pendingMove = null
    if (moveFrame !== null) cancelAnimationFrame(moveFrame)
    moveFrame = null
  }

  const draw = async () => {
    if (drawing || !latest || disposed) return
    drawing = true
    const frame = latest
    latest = null
    try {
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(frame.data)], { type: 'image/jpeg' }))
      if (!disposed && context) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }
        context.drawImage(bitmap, 0, 0)
      }
      bitmap.close()
    } catch {
      // A frame that would not decode is just skipped; the next one is whole.
    } finally {
      drawing = false
      void rpc.call('browser.view.ack', { tabId, seq: frame.seq }).catch(() => {})
      if (latest) void draw()
    }
  }

  const stopFrames = rpc.on('browser.frame', (frame) => {
    if (frame.tabId !== tabId) return
    // Only the newest waits: a slow decode skips what came meanwhile.
    latest = { seq: frame.seq, data: frame.data }
    void draw()
  })

  const start = () => {
    const rect = canvas.getBoundingClientRect()
    if (document.hidden || rect.width === 0) return
    const next = frameBudget(rect.width, rect.height, window.devicePixelRatio, viewport)
    if (next.maxWidth === budget.maxWidth && next.maxHeight === budget.maxHeight) return
    budget = next
    void rpc.call('browser.view.start', { tabId, ...next }).catch(() => {})
  }
  const stop = () => {
    budget = { maxWidth: 0, maxHeight: 0 }
    void rpc.call('browser.view.stop', { tabId }).catch(() => {})
  }
  const onVisibility = () => (document.hidden ? stop() : start())
  const observer = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(start, RESIZE_DEBOUNCE_MS)
  })
  observer.observe(canvas)
  document.addEventListener('visibilitychange', onVisibility)
  start()

  const point = (event: MouseEvent) => toTabPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), viewport)
  const onPointerDown = (event: PointerEvent) => {
    const at = point(event)
    if (!at) return
    event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
    textarea.focus()
    flushMove()
    send(mouseEvent('pressed', event, at))
  }
  const onPointerUp = (event: PointerEvent) => {
    const at = point(event) ?? { x: 0, y: 0 }
    flushMove()
    send(mouseEvent('released', event, at))
  }
  const onPointerMove = (event: PointerEvent) => {
    const at = point(event)
    if (!at) return
    pendingMove = mouseEvent('moved', event, at)
    if (moveFrame === null) moveFrame = requestAnimationFrame(() => { moveFrame = null; flushMove() })
  }
  const onWheel = (event: WheelEvent) => {
    const at = point(event)
    if (!at) return
    event.preventDefault()
    send(wheelEvent(event, at, viewport))
  }
  const onContextMenu = (event: Event) => event.preventDefault()
  const onKey = (action: 'down' | 'up') => (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.shiftKey) {
      if (action === 'down') textarea.blur()
      return
    }
    // Shift+Esc reaches the page as Escape, since Esc alone is the way back to the app.
    const key = keyEvent(action, event.key === 'Escape' ? { ...event, key: 'Escape', code: 'Escape', keyCode: 27, shiftKey: false, isComposing: false } : event)
    if (!key) return
    event.preventDefault()
    send(key)
  }
  const onKeyDown = onKey('down')
  const onKeyUp = onKey('up')
  const onComposition = (event: CompositionEvent) => {
    if (event.data) send({ type: 'text', text: event.data.slice(0, 10_000) })
    textarea.value = ''
  }
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text) send({ type: 'text', text: text.slice(0, 10_000) })
  }
  // A key that types a character is sent as a key and kept out of the textarea, so whatever does
  // land in it came another way: an input method composing (sent when it ends), or text inserted
  // without keys, by automation or autocomplete, which goes as text here.
  const onInput = () => {
    if (isComposing) return
    const text = textarea.value
    textarea.value = ''
    if (text) send({ type: 'text', text: text.slice(0, 10_000) })
  }
  let isComposing = false
  const onCompositionStart = () => { isComposing = true }
  const onCompositionEnd = (event: CompositionEvent) => { isComposing = false; onComposition(event) }
  const onFocus = () => options.onFocus(true)
  const onBlur = () => options.onFocus(false)

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  textarea.addEventListener('keydown', onKeyDown)
  textarea.addEventListener('keyup', onKeyUp)
  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionend', onCompositionEnd)
  textarea.addEventListener('paste', onPaste)
  textarea.addEventListener('input', onInput)
  textarea.addEventListener('focus', onFocus)
  textarea.addEventListener('blur', onBlur)

  return {
    dispose: () => {
      disposed = true
      stopFrames()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (moveFrame !== null) cancelAnimationFrame(moveFrame)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      textarea.removeEventListener('keydown', onKeyDown)
      textarea.removeEventListener('keyup', onKeyUp)
      textarea.removeEventListener('compositionstart', onCompositionStart)
      textarea.removeEventListener('compositionend', onCompositionEnd)
      textarea.removeEventListener('paste', onPaste)
      textarea.removeEventListener('input', onInput)
      textarea.removeEventListener('focus', onFocus)
      textarea.removeEventListener('blur', onBlur)
      stop()
    }
  }
}
