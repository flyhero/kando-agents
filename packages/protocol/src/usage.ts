import { z } from 'zod'
import { AgentKind } from './task'

// session: the rolling 5-hour window · weekly: the 7-day window
export const USAGE_WINDOW_KINDS = ['session', 'weekly'] as const
export const UsageWindowKind = z.enum(USAGE_WINDOW_KINDS)
export type UsageWindowKind = z.infer<typeof UsageWindowKind>

export const UsageWindow = z.object({
  kind: UsageWindowKind,
  // Set when the cap applies to one model only, such as a model-specific weekly limit.
  model: z.string().nullable(),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().positive(),
  resetsAt: z.number().nullable()
})
export type UsageWindow = z.infer<typeof UsageWindow>

// ok: fresh numbers · signed-out: no local credentials for this agent
// error: the last refresh failed; `windows` keeps the previous numbers, now stale
export const UsageStatus = z.enum(['ok', 'signed-out', 'error'])
export type UsageStatus = z.infer<typeof UsageStatus>

// A "usage limit reset" the account holds: using it restores the windows in `clears` once.
export const ResetCredit = z.object({
  expiresAt: z.number().nullable(),
  // The service's own description, such as the promotion it came with.
  label: z.string().nullable().default(null),
  clears: z.array(UsageWindowKind).default([])
})
export type ResetCredit = z.infer<typeof ResetCredit>

export const ResetCredits = z.object({
  available: z.number().int().nonnegative(),
  // The available ones the service listed, soonest to expire first; may be fewer than `available`.
  credits: z.array(ResetCredit),
  // Why the service would not say, when that is something the user can fix: 'cli_version'.
  blockedBy: z.string().nullable().default(null)
})
export type ResetCredits = z.infer<typeof ResetCredits>

export const AgentUsage = z.object({
  agent: AgentKind,
  status: UsageStatus,
  windows: z.array(UsageWindow),
  plan: z.string().nullable(),
  // Stable code the UI can localize, e.g. 'auth-expired'.
  error: z.string().nullable(),
  updatedAt: z.number(),
  // Only Codex reports these; null when there are none to show or the agent has no such thing.
  resetCredits: ResetCredits.nullable().default(null)
})
export type AgentUsage = z.infer<typeof AgentUsage>

export type UsageLevel = 'normal' | 'warning' | 'critical'

export function usageLevel(usedPercent: number): UsageLevel {
  if (usedPercent >= 80) {
    return 'critical'
  }
  return usedPercent >= 60 ? 'warning' : 'normal'
}

// The window closest to its cap is the one that will stall the agent first.
export function tightestWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.reduce<UsageWindow | null>(
    (tightest, window) => (!tightest || window.usedPercent > tightest.usedPercent ? window : tightest),
    null
  )
}
