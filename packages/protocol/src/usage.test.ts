import { describe, expect, it } from 'vitest'
import { tightestWindow, usageLevel, type UsageWindow } from './usage'

const window = (usedPercent: number): UsageWindow => ({
  kind: 'weekly',
  model: null,
  usedPercent,
  windowMinutes: 10_080,
  resetsAt: null
})

describe('usageLevel', () => {
  it('warns from 60% and turns critical from 80%', () => {
    expect([0, 59.9, 60, 79.9, 80, 100].map(usageLevel)).toEqual([
      'normal',
      'normal',
      'warning',
      'warning',
      'critical',
      'critical'
    ])
  })
})

describe('tightestWindow', () => {
  it('picks the window closest to its cap', () => {
    expect(tightestWindow([window(10), window(75), window(30)])?.usedPercent).toBe(75)
    expect(tightestWindow([])).toBeNull()
  })
})
