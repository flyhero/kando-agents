export type Area = { x: number; y: number; width: number; height: number }

// The window's own size: the card plus the margin its shadow is drawn in (styles.css).
export const POPUP_WIDTH = 500
const TOP_GAP = 4
// Taller than this, the card scrolls inside rather than running off the screen.
const MAX_SHARE = 0.8

// Centred at the top of the screen's usable area, under the menu bar or above a top panel.
export function popupBounds(area: Area, height: number): Area {
  const width = Math.min(POPUP_WIDTH, area.width)
  const tallest = Math.max(1, Math.floor(area.height * MAX_SHARE))
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + TOP_GAP,
    width,
    height: Math.min(tallest, Math.max(1, Math.ceil(height)))
  }
}
