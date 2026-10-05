export type UtilityPanelKind = 'browser' | 'terminal' | 'ports'
export type UtilityPanelsOpen = Record<UtilityPanelKind, boolean>

export const UTILITY_PANELS: readonly UtilityPanelKind[] = ['browser', 'terminal', 'ports']
export const UTILITY_PANEL_NAME: Record<UtilityPanelKind, string> = { browser: '浏览器', terminal: '终端', ports: '端口' }
// The dock holds two, one over the other; a third opening puts the top one away.
export const MAX_UTILITY_PANELS = 2

// Open panels are ordered from top to bottom. Closing removes a panel; reopening appends it.
export function updateUtilityPanelOrder(
  order: readonly UtilityPanelKind[],
  panel: UtilityPanelKind,
  open: boolean
): UtilityPanelKind[] {
  const withoutPanel = order.filter((item) => item !== panel)
  return open ? [...withoutPanel, panel] : withoutPanel
}

// The open panels top to bottom, resilient to an order that lacks one (an older in-memory state).
export function visibleUtilityPanelOrder(order: readonly UtilityPanelKind[], open: UtilityPanelsOpen): UtilityPanelKind[] {
  const visible = order.filter((panel) => open[panel])
  for (const panel of UTILITY_PANELS) if (open[panel] && !visible.includes(panel)) visible.push(panel)
  return visible
}

// Opening a panel puts it at the bottom, and the oldest, at the top, away past two. One already
// open stays where it is.
export function openUtilityPanel(order: readonly UtilityPanelKind[], open: UtilityPanelsOpen, panel: UtilityPanelKind): UtilityPanelKind[] {
  const current = visibleUtilityPanelOrder(order, open)
  if (current.includes(panel)) return current
  return [...current, panel].slice(-MAX_UTILITY_PANELS)
}
