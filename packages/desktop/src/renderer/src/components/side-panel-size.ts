export const DEFAULT_SIDE_PANEL_RATIO = 0.42
export const MIN_SIDE_PANEL_RATIO = 0.25
export const MAX_SIDE_PANEL_RATIO = 0.75

export function clampSidePanelRatio(ratio: number): number {
  return Math.min(MAX_SIDE_PANEL_RATIO, Math.max(MIN_SIDE_PANEL_RATIO, ratio))
}

export function sidePanelRatioAtPointer(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
  separatorWidth: number
): number {
  const availableWidth = containerWidth - separatorWidth
  if (availableWidth <= 0) {
    return DEFAULT_SIDE_PANEL_RATIO
  }

  const panelWidth = containerLeft + containerWidth - clientX - separatorWidth / 2
  return clampSidePanelRatio(panelWidth / availableWidth)
}
