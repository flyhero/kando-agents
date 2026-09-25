import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROPOSAL_PANEL_RATIO,
  clampProposalPanelRatio,
  proposalPanelRatioAtPointer
} from './proposal-panel-size'

describe('proposal panel sizing', () => {
  it('limits the panel to a quarter through three quarters of the shared width', () => {
    expect(clampProposalPanelRatio(0.1)).toBe(0.25)
    expect(clampProposalPanelRatio(0.6)).toBe(0.6)
    expect(clampProposalPanelRatio(0.9)).toBe(0.75)
  })

  it('excludes the separator from the terminal and panel shared width', () => {
    expect(proposalPanelRatioAtPointer(496, 100, 808, 8)).toBeCloseTo(0.51)
  })

  it('clamps pointer positions outside the container', () => {
    expect(proposalPanelRatioAtPointer(1_000, 100, 808, 8)).toBe(0.25)
    expect(proposalPanelRatioAtPointer(0, 100, 808, 8)).toBe(0.75)
  })

  it('falls back to the default when no shared width is available', () => {
    expect(proposalPanelRatioAtPointer(100, 100, 8, 8)).toBe(DEFAULT_PROPOSAL_PANEL_RATIO)
  })
})
