import type { Locator, Page } from 'playwright-core'
import { BROWSER_VIEWPORT, type browserActions, type BrowserViewport } from '@kando/protocol'
import type { z } from 'zod'
import { HostError } from './host-error'

type Params<K extends keyof typeof browserActions> = z.output<(typeof browserActions)[K]>

// How long an action waits for its element, and how long a page gets to settle afterwards.
const ACTION_TIMEOUT_MS = 10_000
const SETTLE_TIMEOUT_MS = 3_000
// A wheel tick, in pixels.
const SCROLL_STEP = 100
// A full-page screenshot stops here: a page that scrolls for ever would make a picture the
// model cannot read anyway.
const MAX_FULL_PAGE_HEIGHT = 4000
export const SCREENSHOT_QUALITY = 80

// The AI-mode snapshot gives every element a ref ([ref=e12]); the aria-ref selector engine
// resolves it against the latest snapshot of the page. Kept in one place in case that engine's
// name ever changes.
export function refLocator(page: Page, ref: string): Locator {
  return page.locator(`aria-ref=${ref}`)
}

export async function snapshot(page: Page): Promise<string> {
  try {
    return await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS })
  } catch (error) {
    // A page mid-navigation has no document to read; an empty snapshot says so.
    return error instanceof Error && /navigat|destroyed|closed/i.test(error.message) ? '' : Promise.reject(error)
  }
}

// Gives the page a moment to react to what was just done before it is read again.
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
}

// The page's size as laid out: the panel's, or what it is held at. A page connected over CDP
// reports none of its own, so the window says.
async function viewportOf(page: Page): Promise<BrowserViewport> {
  const known = page.viewportSize()
  if (known) return known
  const measured: unknown = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })').catch(() => null)
  const size = typeof measured === 'object' && measured !== null ? Reflect.get(measured, 'width') : null
  const height = typeof measured === 'object' && measured !== null ? Reflect.get(measured, 'height') : null
  return typeof size === 'number' && size > 0 && typeof height === 'number' && height > 0 ? { width: size, height } : { ...BROWSER_VIEWPORT }
}

// Turns Playwright's own failures into refusals the agent can act on.
async function withElement<T>(ref: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/aria-ref|not found|resolved to|no element|strict mode|waiting for/i.test(message)) {
      throw new HostError('browser-ref-not-found', `找不到 ref ${ref}：页面可能变了，先重新 browser_snapshot`)
    }
    throw error
  }
}

export async function click(page: Page, params: Params<'click'>): Promise<void> {
  await withElement(params.ref, () =>
    refLocator(page, params.ref).click({
      button: params.button,
      clickCount: params.double ? 2 : 1,
      modifiers: params.modifiers,
      timeout: ACTION_TIMEOUT_MS
    })
  )
}

export async function type(page: Page, params: Params<'type'>): Promise<void> {
  await withElement(params.ref, async () => {
    const locator = refLocator(page, params.ref)
    if (params.replace) {
      await locator.fill(params.text, { timeout: ACTION_TIMEOUT_MS })
    } else {
      await locator.click({ timeout: ACTION_TIMEOUT_MS })
      await page.keyboard.type(params.text)
    }
    if (params.submit) await locator.press('Enter', { timeout: ACTION_TIMEOUT_MS })
  })
}

export async function press(page: Page, params: Params<'press'>): Promise<void> {
  await page.keyboard.press(params.key)
}

export async function hover(page: Page, params: Params<'hover'>): Promise<void> {
  await withElement(params.ref, () => refLocator(page, params.ref).hover({ timeout: ACTION_TIMEOUT_MS }))
}

export async function scroll(page: Page, params: Params<'scroll'>): Promise<void> {
  const distance = (params.amount ?? 3) * SCROLL_STEP
  const deltas: Record<typeof params.direction, [number, number]> = {
    up: [0, -distance],
    down: [0, distance],
    left: [-distance, 0],
    right: [distance, 0]
  }
  const [deltaX, deltaY] = deltas[params.direction]
  const viewport = await viewportOf(page)
  let at = { x: viewport.width / 2, y: viewport.height / 2 }
  if (params.ref) {
    const box = await withElement(params.ref, async () => {
      const locator = refLocator(page, params.ref ?? '')
      await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      return locator.boundingBox()
    })
    if (box) at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(deltaX, deltaY)
}

export async function select(page: Page, params: Params<'select'>): Promise<void> {
  await withElement(params.ref, () => refLocator(page, params.ref).selectOption(params.values, { timeout: ACTION_TIMEOUT_MS }))
}

export async function wait(page: Page, params: Params<'wait'>): Promise<void> {
  if (params.text) await page.getByText(params.text).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS * 3 })
  if (params.textGone) await page.getByText(params.textGone).first().waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS * 3 })
  if (params.seconds) await page.waitForTimeout(params.seconds * 1000)
}

// A JPEG of the viewport, of the page down to a cap, or of one element. In CSS pixels: the
// page renders at the screen's density for the user, but the model reads a picture that matches
// the layout it acts on, at a quarter of the bytes.
export async function screenshot(page: Page, params: { fullPage?: boolean; ref?: string }): Promise<Buffer> {
  const options = { type: 'jpeg' as const, quality: SCREENSHOT_QUALITY, scale: 'css' as const, timeout: ACTION_TIMEOUT_MS }
  if (params.ref) {
    const ref = params.ref
    return withElement(ref, () => refLocator(page, ref).screenshot(options))
  }
  if (params.fullPage) {
    const viewport = await viewportOf(page)
    const measured: unknown = await page.evaluate('document.documentElement.scrollHeight').catch(() => null)
    const height = typeof measured === 'number' ? measured : viewport.height
    return height > MAX_FULL_PAGE_HEIGHT
      ? page.screenshot({ ...options, fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: MAX_FULL_PAGE_HEIGHT } })
      : page.screenshot({ ...options, fullPage: true })
  }
  return page.screenshot(options)
}
