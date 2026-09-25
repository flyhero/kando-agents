export const DEFAULT_PROPOSAL_PANEL_RATIO = 0.42
export const MIN_PROPOSAL_PANEL_RATIO = 0.25
export const MAX_PROPOSAL_PANEL_RATIO = 0.75

export function clampProposalPanelRatio(ratio: number): number {
  return Math.min(MAX_PROPOSAL_PANEL_RATIO, Math.max(MIN_PROPOSAL_PANEL_RATIO, ratio))
}

export function proposalPanelRatioAtPointer(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
  separatorWidth: number
): number {
  const availableWidth = containerWidth - separatorWidth
  if (availableWidth <= 0) {
    return DEFAULT_PROPOSAL_PANEL_RATIO
  }

  const panelWidth = containerLeft + containerWidth - clientX - separatorWidth / 2
  return clampProposalPanelRatio(panelWidth / availableWidth)
}
