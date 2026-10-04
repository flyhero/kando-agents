import { MIN_DECIDED_RUNS, type DashboardDay } from '@kando/protocol'

export const DASHBOARD_RANGES = [7, 30, 90] as const
export type DashboardRange = (typeof DASHBOARD_RANGES)[number]

export type Change = { direction: 'up' | 'down' | 'flat'; text: string }

// How a number moved since the range before; null when there was nothing to compare with.
export function change(current: number, previous: number): Change | null {
  if (previous === 0) return null
  const ratio = Math.round(((current - previous) / previous) * 100)
  if (ratio === 0) return { direction: 'flat', text: '持平' }
  return { direction: ratio > 0 ? 'up' : 'down', text: `${Math.abs(ratio)}%` }
}

// A rate is shown only once enough runs were judged for it to say more than luck.
export function acceptance(accepted: number, decided: number): number | null {
  return decided >= MIN_DECIDED_RUNS ? accepted / decided : null
}

export function rateChange(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null) return null
  const points = Math.round((current - previous) * 100)
  if (points === 0) return { direction: 'flat', text: '持平' }
  return { direction: points > 0 ? 'up' : 'down', text: `${Math.abs(points)} 个百分点` }
}

export const activity = (day: DashboardDay) => day.runs + day.turns
export const dayTokens = (day: DashboardDay) => day.runTokens + day.turnTokens

// 0 for no activity, then 1–4 by quartile of the active days, so one busy day does not wash out the rest.
export function heatLevels(values: readonly number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b)
  const cut = (q: number) => active[Math.min(active.length - 1, Math.floor(active.length * q))] ?? 0
  const bounds = [cut(0.25), cut(0.5), cut(0.75)]
  return values.map((value) => (value <= 0 ? 0 : 1 + bounds.filter((bound) => value > bound).length))
}

const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7

// Days into Monday-first weeks, oldest first; null pads the first week before the history starts.
export function weeks<T extends { day: string }>(days: readonly T[]): Array<Array<T | null>> {
  const first = days[0]
  if (!first) return []
  const padded: Array<T | null> = [...Array<null>(weekday(first.day)).fill(null), ...days]
  return Array.from({ length: Math.ceil(padded.length / 7) }, (_, index) => padded.slice(index * 7, index * 7 + 7))
}

// A month's name over the first week that starts in it.
export function monthLabels(columns: ReadonlyArray<ReadonlyArray<{ day: string } | null>>): Array<string | null> {
  let shown: string | null = null
  return columns.map((column) => {
    const day = column.find((entry) => entry !== null)?.day
    const month = day?.slice(0, 7) ?? null
    if (!month || month === shown) return null
    const first = shown === null
    shown = month
    // The first, partial week has no room for a name when the next month starts right after.
    return first && Number(day?.slice(8)) > 21 ? null : `${Number(month.slice(5))}月`
  })
}

// Days with any activity, and the longest run of them back to back.
export function streaks(days: readonly DashboardDay[]): { active: number; longest: number } {
  let longest = 0
  let current = 0
  for (const day of days) {
    current = activity(day) > 0 ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return { active: days.filter((day) => activity(day) > 0).length, longest }
}

export function dayLabel(day: string): string {
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`
}
