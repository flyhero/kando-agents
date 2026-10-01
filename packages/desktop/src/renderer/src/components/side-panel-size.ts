export const DEFAULT_SIDE_PANEL_RATIO = 0.42
export const MIN_SIDE_PANEL_RATIO = 0.25
export const MAX_SIDE_PANEL_RATIO = 0.75
export const DEFAULT_STACKED_PANEL_RATIO = 0.5
export const MIN_STACKED_PANEL_RATIO = 0.2
export const MAX_STACKED_PANEL_RATIO = 0.8

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

export function clampStackedPanelRatio(ratio: number): number {
  return Math.min(MAX_STACKED_PANEL_RATIO, Math.max(MIN_STACKED_PANEL_RATIO, ratio))
}

export function stackedPanelRatioAtPointer(
  clientY: number,
  containerTop: number,
  containerHeight: number,
  separatorHeight: number
): number {
  const availableHeight = containerHeight - separatorHeight
  if (availableHeight <= 0) {
    return DEFAULT_STACKED_PANEL_RATIO
  }

  const upperPanelHeight = clientY - containerTop - separatorHeight / 2
  return clampStackedPanelRatio(upperPanelHeight / availableHeight)
}
