export type UtilityPanelKind = 'browser' | 'terminal'

// Open panels are ordered from top to bottom. Closing removes a panel; reopening appends it.
export function updateUtilityPanelOrder(
  order: readonly UtilityPanelKind[],
  panel: UtilityPanelKind,
  open: boolean
): UtilityPanelKind[] {
  const withoutPanel = order.filter((item) => item !== panel)
  return open ? [...withoutPanel, panel] : withoutPanel
}

// Keep rendering resilient if an older in-memory state has no order yet.
export function visibleUtilityPanelOrder(
  order: readonly UtilityPanelKind[],
  browserOpen: boolean,
  terminalOpen: boolean
): UtilityPanelKind[] {
  const visible = order.filter((panel) => panel === 'browser' ? browserOpen : terminalOpen)
  if (browserOpen && !visible.includes('browser')) visible.push('browser')
  if (terminalOpen && !visible.includes('terminal')) visible.push('terminal')
  return visible
}
