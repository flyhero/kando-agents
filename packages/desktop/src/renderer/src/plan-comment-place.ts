// Where the comment box sits beside a selected passage. A right-click menu opens on that same
// passage and would cover the box, so the box takes the other side and, if it still meets the
// menu, moves clear of it.

export type Bounds = { left: number; top: number; right: number; bottom: number }

export const PLAN_COMMENT_BOX = { width: 300, height: 48 } as const
// One「复制」row, as .context-menu is sized. Close enough to choose a side before the menu paints.
export const PLAN_SELECTION_MENU = { width: 180, height: 44 } as const

const GAP = 8
const EDGE = 8

export type CommentBoxPlace = { left: number; top: number }

function placedMenu(at: { x: number; y: number }, width: number, height: number, viewport: { width: number; height: number }): Bounds {
  const left = at.x + width > viewport.width - EDGE ? Math.max(EDGE, at.x - width) : at.x
  const top = at.y + height > viewport.height - EDGE ? Math.max(EDGE, at.y - height) : at.y
  return { left, top, right: left + width, bottom: top + height }
}

function beside(passage: Bounds, above: boolean): number {
  return above ? passage.top - PLAN_COMMENT_BOX.height - GAP : passage.bottom + GAP
}

function fits(top: number, viewportHeight: number): boolean {
  return top >= EDGE && top + PLAN_COMMENT_BOX.height <= viewportHeight - EDGE
}

function meets(top: number, left: number, menu: Bounds): boolean {
  const boxLeft = left - PLAN_COMMENT_BOX.width / 2
  const boxRight = left + PLAN_COMMENT_BOX.width / 2
  const boxBottom = top + PLAN_COMMENT_BOX.height
  return boxLeft < menu.right && boxRight > menu.left && top < menu.bottom && boxBottom > menu.top
}

function clearOf(top: number, menu: Bounds, viewportHeight: number): number {
  const aboveMenu = menu.top - GAP - PLAN_COMMENT_BOX.height
  const belowMenu = menu.bottom + GAP
  const boxMid = top + PLAN_COMMENT_BOX.height / 2
  const menuMid = (menu.top + menu.bottom) / 2
  const first = boxMid <= menuMid ? aboveMenu : belowMenu
  const second = first === aboveMenu ? belowMenu : aboveMenu
  if (fits(first, viewportHeight)) return first
  if (fits(second, viewportHeight)) return second
  return Math.max(EDGE, Math.min(first, viewportHeight - EDGE - PLAN_COMMENT_BOX.height))
}

export function placeCommentBox({ passage, anchorX, panel, viewport, menu }: {
  passage: Bounds
  anchorX: number
  panel: { left: number; right: number } | null
  viewport: { width: number; height: number }
  menu: { at: { x: number; y: number }; width: number; height: number } | null
}): CommentBoxPlace {
  const half = PLAN_COMMENT_BOX.width / 2 + EDGE
  const min = (panel?.left ?? 0) + half
  const max = (panel?.right ?? viewport.width) - half
  const left = Math.min(Math.max(anchorX, min), max)
  let above = !fits(beside(passage, false), viewport.height)
  if (menu) {
    const placed = placedMenu(menu.at, menu.width, menu.height, viewport)
    const opensDown = placed.top >= menu.at.y
    const inLowerHalf = menu.at.y >= (passage.top + passage.bottom) / 2
    above = (opensDown || inLowerHalf) && placed.bottom > passage.top
    const preferred = beside(passage, above)
    const other = beside(passage, !above)
    if (!fits(preferred, viewport.height) && fits(other, viewport.height)) above = !above
  }
  let top = beside(passage, above)
  if (menu) {
    const placed = placedMenu(menu.at, menu.width, menu.height, viewport)
    if (meets(top, left, placed)) top = clearOf(top, placed, viewport.height)
  }
  return { left, top }
}
