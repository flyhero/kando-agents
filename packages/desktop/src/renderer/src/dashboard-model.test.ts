import { describe, expect, it } from 'vitest'
import type { DashboardDay } from '@kando/protocol'
import { acceptance, change, dayLabel, heatLevels, monthLabels, rateChange, streaks, weeks } from './dashboard-model'

const day = (date: string, runs = 0, turns = 0): DashboardDay => ({ day: date, runs, accepted: 0, turns, runTokens: 0, turnTokens: 0 })

describe('change', () => {
  it('says how far a number moved, and nothing without a range to compare with', () => {
    expect(change(15, 10)).toEqual({ direction: 'up', text: '50%' })
    expect(change(5, 10)).toEqual({ direction: 'down', text: '50%' })
    expect(change(10, 10)).toEqual({ direction: 'flat', text: '持平' })
    expect(change(3, 0)).toBeNull()
  })

  it('moves a rate in percentage points, once both rates are known', () => {
    expect(rateChange(0.8, 0.5)).toEqual({ direction: 'up', text: '30 个百分点' })
    expect(rateChange(0.8, null)).toBeNull()
    expect(acceptance(3, 4)).toBeNull()
    expect(acceptance(4, 5)).toBe(0.8)
  })
})

describe('heatLevels', () => {
  it('keeps empty days at 0 and spreads the active ones over four levels', () => {
    expect(heatLevels([0, 1, 2, 3, 4, 100])).toEqual([0, 1, 1, 2, 3, 4])
    expect(heatLevels([0, 5, 5])).toEqual([0, 1, 1])
  })
})

describe('weeks', () => {
  it('starts every week on Monday, padding the first', () => {
    // 2026-10-01 is a Thursday.
    const columns = weeks(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) => day(date)))
    expect(columns.map((column) => column.map((entry) => entry?.day.slice(8) ?? null))).toEqual([
      [null, null, null, '01', '02', '03', '04'],
      ['05']
    ])
  })

  it('names each month over the first week that starts in it', () => {
    const columns = weeks(Array.from({ length: 35 }, (_, index) => day(new Date(Date.UTC(2026, 8, 7 + index)).toISOString().slice(0, 10))))
    expect(monthLabels(columns)).toEqual(['9月', null, null, null, '10月'])
  })
})

describe('streaks', () => {
  it('counts active days and the longest stretch of them', () => {
    expect(streaks([day('a', 1), day('b', 0, 2), day('c'), day('d', 1), day('e', 1), day('f', 0, 1)])).toEqual({ active: 5, longest: 3 })
  })
})

it('writes a day the way the page does', () => {
  expect(dayLabel('2026-10-04')).toBe('10月4日')
})
