import { z } from 'zod'

// Its own module so chat and task can both use it: a task keeps the chat options it starts in.
export const AGENT_KINDS = ['claude', 'codex', 'cursor'] as const
export const AgentKind = z.enum(AGENT_KINDS)
export type AgentKind = z.infer<typeof AgentKind>
