import { z } from 'zod'
import { AgentKind } from './task'

// How one agent's finished runs on tasks went, for one model (null: not known, as for a run whose
// agent never reported one).
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
  // From start to hand-in, the user's time in between included.
  medianDurationMs: z.number().nullable(),
  medianTokens: z.number().nullable()
})
export type AgentStats = z.infer<typeof AgentStats>

// Below this many judged runs a rate says more about luck than about the agent.
export const MIN_DECIDED_RUNS = 5

// How one agent's turns in free conversations (chat mode) went, for one model: what they cost and
// how often they broke off. Conversations are never judged, so there is no rate of good results here.
export const ConversationStats = z.object({
  agent: AgentKind,
  model: z.string().nullable(),
  conversations: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
  // Failed turns the account's usage limit stopped, counted among the failed too.
  usageLimits: z.number().int().nonnegative(),
  // The agent's own working time per turn.
  medianTurnMs: z.number().nullable(),
  medianTurnTokens: z.number().nullable(),
  totalTokens: z.number().nonnegative()
})
export type ConversationStats = z.infer<typeof ConversationStats>
