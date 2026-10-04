import { z } from 'zod'
import { AgentKind } from './task'

// Days count as the client's calendar days, which is why it names its time zone.
export const DASHBOARD_MAX_RANGE = 90
// Day by day history for the activity map: 53 weeks, so a full year shows whatever weekday today is.
export const DASHBOARD_HISTORY_DAYS = 371

const count = z.number().int().nonnegative()

// One calendar day: task runs that ended that day and free-conversation turns that ended that day.
export const DashboardDay = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runs: count,
  accepted: count,
  turns: count,
  runTokens: z.number().nonnegative(),
  turnTokens: z.number().nonnegative()
})
export type DashboardDay = z.infer<typeof DashboardDay>

// A range of days added up, for the headline numbers and their change on the range before.
export const DashboardTotals = z.object({
  runs: count,
  // Runs the user has since accepted, sent back or redone: what the acceptance rate divides by.
  decided: count,
  accepted: count,
  medianRunMs: z.number().nullable(),
  turns: count,
  failedTurns: count,
  interruptedTurns: count,
  tokens: z.number().nonnegative()
})
export type DashboardTotals = z.infer<typeof DashboardTotals>

export const DashboardModel = z.object({
  agent: AgentKind,
  model: z.string().nullable(),
  runs: count,
  decided: count,
  accepted: count,
  medianRunMs: z.number().nullable(),
  turns: count,
  tokens: z.number().nonnegative()
})
export type DashboardModel = z.infer<typeof DashboardModel>

export const DashboardStats = z.object({
  // Oldest first, DASHBOARD_HISTORY_DAYS of them ending today, empty days included.
  days: z.array(DashboardDay),
  current: DashboardTotals,
  previous: DashboardTotals,
  // The current range, per agent and model.
  models: z.array(DashboardModel)
})
export type DashboardStats = z.infer<typeof DashboardStats>

export const DashboardParams = z.object({
  // The current range, today included; the previous range is as many days before it.
  range: z.number().int().min(1).max(DASHBOARD_MAX_RANGE),
  timeZone: z.string().refine(isTimeZone, 'unknown time zone')
})

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}
