import { z } from 'zod'
import { AgentKind } from './task'

// How one agent's finished runs on tasks went, for one model (null: not known, as for every
// terminal run, whose CLI is never told one).
export const AgentStats = z.object({
  agent: AgentKind,
  model: z.string().nullable(),
  // Runs that have ended, judged or not.
  runs: z.number().int().nonnegative(),
  // Of those, the ones the user has since taken, sent back or started over: what rates divide by.
  decided: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  continued: z.number().int().nonnegative(),
  redone: z.number().int().nonnegative(),
  // Terminal runs that ended, and of those the ones whose agent exited with an error.
  endedTerminal: z.number().int().nonnegative(),
  abnormalExits: z.number().int().nonnegative(),
  // From start to hand-in, the user's time in between included.
  medianDurationMs: z.number().nullable(),
  // Chat runs only: a terminal run reports no tokens.
  medianTokens: z.number().nullable()
})
export type AgentStats = z.infer<typeof AgentStats>

// Below this many judged runs a rate says more about luck than about the agent.
export const MIN_DECIDED_RUNS = 5
