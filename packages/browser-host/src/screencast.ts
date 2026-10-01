import type { BrowserContext, CDPSession, Page } from 'playwright-core'
import { BROWSER_FRAME_QUALITY, BROWSER_VIEWPORT, type BrowserFrame, type BrowserInputEvent, type BrowserViewOptions } from '@kando/protocol'

// Chromium sends the next frame only once the last one is acknowledged, so holding the ack
// this long after a frame caps the rate without a timer loop or a queue.
const FRAME_INTERVAL_MS = 100

type Live = { session: CDPSession; seq: number; lastSentAt: number; streaming: boolean }

// The size a JPEG's start-of-frame marker declares. CDP reports the page's own size with a
// frame, not the scaled frame's, so the picture itself is asked.
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
  let at = 2
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null
    const marker = jpeg[at + 1] ?? 0
    // Start-of-frame markers, all but the arithmetic-coding tables that share their range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) }
    }
    at += 2 + jpeg.readUInt16BE(at + 2)
  }
  return null
}

// One CDP session per tab, for what Playwright's API does not cover: the compositor's own
// stream of frames, and raw input the way a real pointer and keyboard would give it.
export class Screencast {
  private readonly live = new Map<string, Live>()

  constructor(
    private readonly context: BrowserContext,
    private readonly emit: (frame: BrowserFrame) => void
  ) {}

  private async sessionFor(tabId: string, page: Page): Promise<Live> {
    const existing = this.live.get(tabId)
    if (existing) return existing
    const session = await this.context.newCDPSession(page)
    const live: Live = { session, seq: 0, lastSentAt: 0, streaming: false }
    session.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      live.seq += 1
      const now = Date.now()
      const size = jpegSize(Buffer.from(frame.data, 'base64')) ?? { width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight }
      this.emit({ tabId, seq: live.seq, width: size.width, height: size.height, data: frame.data })
      const wait = Math.max(0, FRAME_INTERVAL_MS - (now - live.lastSentAt))
      live.lastSentAt = now + wait
      setTimeout(() => {
        session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      }, wait)
    })
    page.once('close', () => this.live.delete(tabId))
    this.live.set(tabId, live)
    return live
  }

  async start(tabId: string, page: Page, options: BrowserViewOptions): Promise<void> {
    const live = await this.sessionFor(tabId, page)
    if (live.streaming) await live.session.send('Page.stopScreencast').catch(() => {})
    live.streaming = true
    await live.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: options.quality ?? BROWSER_FRAME_QUALITY,
      maxWidth: options.maxWidth ?? BROWSER_VIEWPORT.width,
      maxHeight: options.maxHeight ?? BROWSER_VIEWPORT.height,
      everyNthFrame: 1
    })
  }

  async stop(tabId: string): Promise<void> {
    const live = this.live.get(tabId)
    if (!live?.streaming) return
    live.streaming = false
    await live.session.send('Page.stopScreencast').catch(() => {})
  }

  async input(tabId: string, page: Page, event: BrowserInputEvent): Promise<void> {
    const { session } = await this.sessionFor(tabId, page)
    switch (event.type) {
      case 'mouse':
        await session.send('Input.dispatchMouseEvent', {
          type: ({ pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved' } as const)[event.action],
          x: event.x,
          y: event.y,
          button: event.button,
          buttons: event.buttons,
          clickCount: event.clickCount,
          modifiers: event.modifiers
        })
        return
      case 'wheel':
        await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers })
        return
      case 'key':
        await session.send('Input.dispatchKeyEvent', {
          type: event.action === 'down' ? (event.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.windowsVirtualKeyCode,
          nativeVirtualKeyCode: event.windowsVirtualKeyCode,
          text: event.text,
          unmodifiedText: event.text,
          modifiers: event.modifiers
        })
        return
      case 'text':
        await session.send('Input.insertText', { text: event.text })
        return
    }
  }
}
