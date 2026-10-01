import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDE_PANEL_RATIO,
  DEFAULT_STACKED_PANEL_RATIO,
  clampSidePanelRatio,
  clampStackedPanelRatio,
  sidePanelRatioAtPointer,
  stackedPanelRatioAtPointer
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

describe('stacked panel sizing', () => {
  it('keeps both panels visible', () => {
    expect(clampStackedPanelRatio(0.1)).toBe(0.2)
    expect(clampStackedPanelRatio(0.6)).toBe(0.6)
    expect(clampStackedPanelRatio(0.9)).toBe(0.8)
  })

  it('measures the upper panel without the horizontal separator', () => {
    expect(stackedPanelRatioAtPointer(402, 100, 608, 8)).toBeCloseTo(0.4967)
  })

  it('clamps pointer positions outside the dock', () => {
    expect(stackedPanelRatioAtPointer(0, 100, 608, 8)).toBe(0.2)
    expect(stackedPanelRatioAtPointer(1_000, 100, 608, 8)).toBe(0.8)
  })

  it('falls back to the default when no shared height is available', () => {
    expect(stackedPanelRatioAtPointer(100, 100, 8, 8)).toBe(DEFAULT_STACKED_PANEL_RATIO)
  })
})
