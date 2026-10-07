import { z } from 'zod'
import { AgentKind } from './task'

// What passed between Kando and a chat agent's process, as it went, for the user to debug with:
// spawn, the command it started with · stdin, a line Kando wrote · stdout, a line the agent wrote,
// whether or not it is JSON · stderr, a chunk as it came · exit, how it ended · note, Kando's own
// word on the record itself (a gap, the size limit reached).
export const WIRE_DIRECTIONS = ['spawn', 'stdin', 'stdout', 'stderr', 'exit', 'note'] as const
export const WireDirection = z.enum(WIRE_DIRECTIONS)
export type WireDirection = z.infer<typeof WireDirection>

export const WireEntry = z.object({
  // Where the entry starts in its stage's wire log, in bytes: its id, and where paging goes on from.
  pos: z.number().int().nonnegative(),
  at: z.number(),
  dir: WireDirection,
  // The line as it went, without its newline; spawn and exit carry JSON of Kando's own.
  text: z.string(),
  // The text's length before it was cut short, when it was.
  cut: z.number().int().optional()
})
export type WireEntry = z.infer<typeof WireEntry>

// A stage of the conversation with a wire log, newest first. One whose agent never started is
// gone from the conversation, with only its log left: agent null, startedAt when the log began.
export const WireStage = z.object({
  stageId: z.string(),
  agent: AgentKind.nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  bytes: z.number().int().nonnegative(),
  // The log on core's disk, for a client on the same machine to show.
  file: z.string()
})
export type WireStage = z.infer<typeof WireStage>

// The newest entries of one stage before `before` (a pos), oldest first; before is null once
// nothing older is left. stageId is the stage shown, null when the conversation has no log.
export const WirePage = z.object({
  stages: z.array(WireStage),
  stageId: z.string().nullable(),
  entries: z.array(WireEntry),
  before: z.number().int().nullable()
})
export type WirePage = z.infer<typeof WirePage>

export const WireUsage = z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })
export type WireUsage = z.infer<typeof WireUsage>
