export const DEFAULT_SIDEBAR_WIDTH = 320
// Narrower and the task list's header tools no longer fit beside its name.
export const MIN_SIDEBAR_WIDTH = 240
export const MAX_SIDEBAR_WIDTH = 480
// Never more of the window than this, so a small window keeps room for the pane. styles.css caps
// `.sidebar` at the same 40vw for when the window shrinks after a drag.
const MAX_WINDOW_SHARE = 0.4
// How far an arrow key moves the edge.
export const SIDEBAR_WIDTH_STEP = 16

export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(windowWidth * MAX_WINDOW_SHARE)))
}

export function clampSidebarWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(sidebarMaxWidth(windowWidth), Math.max(MIN_SIDEBAR_WIDTH, width)))
}
