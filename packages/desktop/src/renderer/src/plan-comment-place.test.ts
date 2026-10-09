import { expect, it } from 'vitest'
import { PLAN_COMMENT_BOX, PLAN_SELECTION_MENU, placeCommentBox, type Bounds } from './plan-comment-place'

const viewport = { width: 800, height: 600 }
const panel = { left: 400, right: 780 }
const passage: Bounds = { left: 420, top: 200, right: 700, bottom: 248 }

function place(menu: { x: number; y: number } | null, over: Partial<Bounds> = {}) {
  return placeCommentBox({
    passage: { ...passage, ...over },
    anchorX: 560,
    panel,
    viewport,
    menu: menu ? { at: menu, ...PLAN_SELECTION_MENU } : null
  })
}

it('sits under the passage, centred, and inside the panel', () => {
  expect(place(null)).toEqual({ left: 560, top: passage.bottom + 8 })
  expect(place(null, { left: 700, right: 760 }).left).toBe(560)
  const squeezed = placeCommentBox({
    passage,
    anchorX: 410,
    panel,
    viewport,
    menu: null
  })
  expect(squeezed.left).toBe(panel.left + PLAN_COMMENT_BOX.width / 2 + 8)
})

it('moves above the passage when the window has no room below', () => {
  const low: Bounds = { left: 420, top: 540, right: 700, bottom: 580 }
  expect(placeCommentBox({ passage: low, anchorX: 560, panel, viewport, menu: null }).top).toBe(low.top - PLAN_COMMENT_BOX.height - 8)
})

it('moves above a menu that opens downward over the passage', () => {
  const box = place({ x: 500, y: 230 })
  expect(box.top).toBe(passage.top - PLAN_COMMENT_BOX.height - 8)
  expect(box.top + PLAN_COMMENT_BOX.height).toBeLessThan(230)
})

it('stays below a menu that sits above the passage', () => {
  const box = place({ x: 500, y: 100 })
  expect(box.top).toBe(passage.bottom + 8)
})

it('shifts clear when the preferred side does not fit', () => {
  const high: Bounds = { left: 420, top: 16, right: 700, bottom: 40 }
  const box = placeCommentBox({
    passage: high,
    anchorX: 560,
    panel,
    viewport,
    menu: { at: { x: 500, y: 30 }, ...PLAN_SELECTION_MENU }
  })
  const menuBottom = 30 + PLAN_SELECTION_MENU.height
  expect(box.top).toBeGreaterThanOrEqual(menuBottom)
})
