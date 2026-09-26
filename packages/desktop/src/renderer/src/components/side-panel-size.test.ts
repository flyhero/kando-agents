import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDE_PANEL_RATIO,
  clampSidePanelRatio,
  sidePanelRatioAtPointer
} from './side-panel-size'

describe('side panel sizing', () => {
  it('limits the panel to a quarter through three quarters of the shared width', () => {
    expect(clampSidePanelRatio(0.1)).toBe(0.25)
    expect(clampSidePanelRatio(0.6)).toBe(0.6)
    expect(clampSidePanelRatio(0.9)).toBe(0.75)
  })

  it('excludes the separator from the terminal and panel shared width', () => {
    expect(sidePanelRatioAtPointer(496, 100, 808, 8)).toBeCloseTo(0.51)
  })

  it('clamps pointer positions outside the container', () => {
    expect(sidePanelRatioAtPointer(1_000, 100, 808, 8)).toBe(0.25)
    expect(sidePanelRatioAtPointer(0, 100, 808, 8)).toBe(0.75)
  })

  it('falls back to the default when no shared width is available', () => {
    expect(sidePanelRatioAtPointer(100, 100, 8, 8)).toBe(DEFAULT_SIDE_PANEL_RATIO)
  })
})
