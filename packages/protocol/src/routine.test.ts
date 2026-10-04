import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isValidSchedule, latestOccurrenceAtOrBefore, nextOccurrence, Routine, RoutineList, type RoutineSchedule } from './routine'

const at = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()

describe('nextOccurrence', () => {
  it('names the time today when it is still to come, else tomorrow', () => {
    const daily: RoutineSchedule = { kind: 'daily', time: '09:00' }
    expect(nextOccurrence(daily, at(2026, 10, 4, 8, 59))).toBe(at(2026, 10, 4, 9))
    expect(nextOccurrence(daily, at(2026, 10, 4, 9, 0))).toBe(at(2026, 10, 5, 9))
    expect(nextOccurrence(daily, at(2026, 10, 4, 9, 1))).toBe(at(2026, 10, 5, 9))
  })

  it('skips the weekend for a weekdays schedule', () => {
    // 2026-10-03 is a Saturday.
    expect(nextOccurrence({ kind: 'weekdays', time: '09:00' }, at(2026, 10, 3, 10))).toBe(at(2026, 10, 5, 9))
    expect(nextOccurrence({ kind: 'weekdays', time: '09:00' }, at(2026, 10, 2, 10))).toBe(at(2026, 10, 5, 9))
  })

  it('finds the named weekday up to a week out', () => {
    // 2026-10-04 is a Sunday; 3 is Wednesday.
    expect(nextOccurrence({ kind: 'weekly', days: [3], time: '18:30' }, at(2026, 10, 4, 12))).toBe(at(2026, 10, 7, 18, 30))
    expect(nextOccurrence({ kind: 'weekly', days: [0], time: '18:30' }, at(2026, 10, 4, 19))).toBe(at(2026, 10, 11, 18, 30))
    expect(nextOccurrence({ kind: 'weekly', days: [0, 3], time: '18:30' }, at(2026, 10, 4, 18, 30))).toBe(at(2026, 10, 7, 18, 30))
  })

  it('aligns hourly runs to midnight and wraps to the next day', () => {
    expect(nextOccurrence({ kind: 'hourly', every: 1 }, at(2026, 10, 4, 8, 30))).toBe(at(2026, 10, 4, 9))
    expect(nextOccurrence({ kind: 'hourly', every: 3 }, at(2026, 10, 4, 8, 30))).toBe(at(2026, 10, 4, 9))
    expect(nextOccurrence({ kind: 'hourly', every: 3 }, at(2026, 10, 4, 9, 0))).toBe(at(2026, 10, 4, 12))
    expect(nextOccurrence({ kind: 'hourly', every: 12 }, at(2026, 10, 4, 12, 0))).toBe(at(2026, 10, 5, 0))
    expect(nextOccurrence({ kind: 'hourly', every: 1 }, at(2026, 10, 4, 23, 30))).toBe(at(2026, 10, 5, 0))
  })

  it('names nothing for a manual or malformed schedule', () => {
    expect(nextOccurrence({ kind: 'manual' }, at(2026, 10, 4, 8))).toBeNull()
    expect(nextOccurrence({ kind: 'daily', time: '25:00' }, at(2026, 10, 4, 8))).toBeNull()
    expect(nextOccurrence({ kind: 'daily', time: '9:00' }, at(2026, 10, 4, 8))).toBeNull()
    expect(nextOccurrence({ kind: 'weekly', days: [], time: '09:00' }, at(2026, 10, 4, 8))).toBeNull()
    expect(nextOccurrence({ kind: 'weekly', days: [7], time: '09:00' }, at(2026, 10, 4, 8))).toBeNull()
    expect(nextOccurrence({ kind: 'hourly', every: 5 }, at(2026, 10, 4, 8))).toBeNull()
  })
})

describe('latestOccurrenceAtOrBefore', () => {
  it('names the most recent time at or before now, which a sleeping computer makes up for', () => {
    const daily: RoutineSchedule = { kind: 'daily', time: '09:00' }
    expect(latestOccurrenceAtOrBefore(daily, at(2026, 10, 4, 9, 0))).toBe(at(2026, 10, 4, 9))
    expect(latestOccurrenceAtOrBefore(daily, at(2026, 10, 4, 8, 59))).toBe(at(2026, 10, 3, 9))
    expect(latestOccurrenceAtOrBefore({ kind: 'weekdays', time: '09:00' }, at(2026, 10, 4, 12))).toBe(at(2026, 10, 2, 9))
    expect(latestOccurrenceAtOrBefore({ kind: 'hourly', every: 3 }, at(2026, 10, 4, 0, 30))).toBe(at(2026, 10, 4, 0))
    expect(latestOccurrenceAtOrBefore({ kind: 'hourly', every: 6 }, at(2026, 10, 4, 5, 30))).toBe(at(2026, 10, 4, 0))
    expect(latestOccurrenceAtOrBefore({ kind: 'manual' }, at(2026, 10, 4, 5))).toBeNull()
  })

  it('is the inverse of nextOccurrence', () => {
    const weekly: RoutineSchedule = { kind: 'weekly', days: [1, 4], time: '07:15' }
    const next = nextOccurrence(weekly, at(2026, 10, 4, 0))!
    expect(latestOccurrenceAtOrBefore(weekly, next)).toBe(next)
    expect(nextOccurrence(weekly, next - 1)).toBe(next)
    expect(latestOccurrenceAtOrBefore(weekly, next - 1)).toBeLessThan(next)
  })
})

describe('isValidSchedule', () => {
  it('accepts manual and anything that names a time', () => {
    expect(isValidSchedule({ kind: 'manual' })).toBe(true)
    expect(isValidSchedule({ kind: 'daily', time: '00:00' })).toBe(true)
    expect(isValidSchedule({ kind: 'weekly', days: [], time: '09:00' })).toBe(false)
    expect(isValidSchedule({ kind: 'hourly', every: 7 })).toBe(false)
  })
})

describe('across a change of clocks', () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it('runs an hour late, once, at a time the spring-forward day skips', () => {
    // 2026-03-08: 02:00 becomes 03:00.
    const next = nextOccurrence({ kind: 'daily', time: '02:30' }, at(2026, 3, 8, 0))!
    const when = new Date(next)
    expect([when.getDate(), when.getHours(), when.getMinutes()]).toEqual([8, 3, 30])
    const after = new Date(nextOccurrence({ kind: 'daily', time: '02:30' }, next)!)
    expect([after.getDate(), after.getHours(), after.getMinutes()]).toEqual([9, 2, 30])
  })

  it('runs once at a time the fall-back day has twice', () => {
    // 2026-11-01: 02:00 becomes 01:00 again.
    const first = nextOccurrence({ kind: 'daily', time: '01:30' }, at(2026, 11, 1, 0))!
    const second = nextOccurrence({ kind: 'daily', time: '01:30' }, first)!
    expect(new Date(first).getDate()).toBe(1)
    expect(new Date(second).getDate()).toBe(2)
    // The hourly schedule has a slot for each hour the day counts, including the repeated one.
    const hours: number[] = []
    for (let time = at(2026, 11, 1, 0); time < at(2026, 11, 2, 0); time = nextOccurrence({ kind: 'hourly', every: 1 }, time)!) hours.push(time)
    expect(hours.length).toBe(24)
  })
})

describe('RoutineList', () => {
  const routine = {
    id: '00000000-0000-4000-8000-000000000001',
    title: '日报',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00' },
    target: { kind: 'new', agent: 'auto', projectPaths: [], text: '写日报' },
    nextRunAt: 1,
    lastFiredAt: null,
    unread: 0,
    lastRun: null,
    createdAt: 0,
    updatedAt: 0
  }

  it('drops a routine this client does not understand and keeps the rest', () => {
    const odd = { ...routine, id: '00000000-0000-4000-8000-000000000002', schedule: { kind: 'lunar', phase: 'full' } }
    expect(RoutineList.parse([routine, odd]).map((each) => each.id)).toEqual([routine.id])
    expect(Routine.parse(routine).target.agent).toBe('auto')
  })
})
