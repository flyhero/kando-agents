import { z } from 'zod'
import { AttachmentId, MAX_CHAT_IMAGES } from './attachments'
import { AgentKind, checkStart, startKind, type StartBlocker, type Task } from './task'

// The usageLimit chat item a run answers: the one whose turn the limit stopped.
export const LimitRef = z.object({ stageId: z.string(), itemId: z.string() })
export type LimitRef = z.infer<typeof LimitRef>

// What a scheduled run does when it comes due: start a task; go on in a conversation (a task's
// included) with a message, or, when the text is empty, by approving a plan waiting there or
// telling the agent to carry out the plan it has; or resume a conversation whose turn the usage
// limit stopped, in the mode it was in, which core schedules by itself when the limit is hit.
// A conversation run made where a resume waited, or hit by the limit while it waited, takes the
// limit over (`resumes`): it continues the stopped turn instead of starting on the plan.
const TaskTarget = z.object({ kind: z.literal('task'), taskId: z.string().min(1) })
// images: the message's pictures, by their names in core's attachment store, which keeps them;
// older cores leave them out.
const ConversationTarget = z.object({
  kind: z.literal('conversation'),
  conversationId: z.string().uuid(),
  text: z.string().trim().max(100000),
  images: z.array(AttachmentId).max(MAX_CHAT_IMAGES).optional(),
  resumes: LimitRef.optional()
})
const ResumeTarget = z.object({ kind: z.literal('resume'), conversationId: z.string().uuid(), stageId: z.string(), itemId: z.string() })
// A routine's run: opens a conversation (whose id is the run's own) for what the routine says
// when it starts, so a routine edited meanwhile is carried out as it reads now. Core makes
// these; a client never asks for one.
const RoutineRunTarget = z.object({ kind: z.literal('routine'), routineId: z.string().uuid() })
export const ScheduledTarget = z.discriminatedUnion('kind', [TaskTarget, ConversationTarget, ResumeTarget, RoutineRunTarget])
export type ScheduledTarget = z.infer<typeof ScheduledTarget>
// What a client may schedule; core makes the resume runs itself.
export const RequestedTarget = z.discriminatedUnion('kind', [TaskTarget, ConversationTarget])
export type RequestedTarget = z.infer<typeof RequestedTarget>

// The limit a run answers, whichever way it does.
export function limitOf(target: ScheduledTarget): LimitRef | null {
  if (target.kind === 'resume') return { stageId: target.stageId, itemId: target.itemId }
  return target.kind === 'conversation' ? target.resumes ?? null : null
}

// waiting: for its time, its agent's quota, or another of the agent's runs to finish · starting:
// core is starting it now · started: under way, or done; its chat tells · failed: core gave up,
// error says why · cancelled: by the user, or its target went.
export const SCHEDULE_STATUSES = ['waiting', 'starting', 'started', 'failed', 'cancelled'] as const
export const ScheduleStatus = z.enum(SCHEDULE_STATUSES)
export type ScheduleStatus = z.infer<typeof ScheduleStatus>

// How a routine run's turn ended: as the agent reported, or 'awaiting' while it waits on the
// user to answer or allow something.
export const ROUTINE_OUTCOMES = ['completed', 'failed', 'interrupted', 'awaiting'] as const
export const RoutineOutcome = z.enum(ROUTINE_OUTCOMES)
export type RoutineOutcome = z.infer<typeof RoutineOutcome>

export const ScheduledRun = z.object({
  id: z.string().uuid(),
  target: ScheduledTarget,
  // As the target was named when scheduled, so the list still reads once it is gone.
  title: z.string(),
  agent: AgentKind,
  // Not before this; null for as soon as the quota allows. Every run waits for its agent's quota.
  notBefore: z.number().nullable(),
  // When the agent's quota is next known to reset, while it is used up; null otherwise.
  resetsAt: z.number().nullable(),
  status: ScheduleStatus.catch('cancelled'),
  // The conversation the run went on in, once it started: where to look at what it did.
  conversationId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.number(),
  // When it started, failed or was cancelled.
  settledAt: z.number().nullable(),
  // For a run a routine made: the routine, and the time on its schedule the run stands for
  // (a run made up for after the computer slept is later than its dueAt). Older cores leave
  // them out, and they are null on every other run.
  routineId: z.string().uuid().nullable().optional(),
  dueAt: z.number().nullable().optional(),
  // When the routine run's turn ended, how, and when the user looked at the result; a run that
  // failed to start is also something to look at. An outcome this client does not know reads as null.
  finishedAt: z.number().nullable().optional(),
  outcome: RoutineOutcome.nullable().catch(null).optional(),
  seenAt: z.number().nullable().optional()
})
export type ScheduledRun = z.infer<typeof ScheduledRun>

// Parsed one by one, so a run a newer core describes differently (a target kind this client does
// not know) drops alone rather than taking the list with it.
export const ScheduledRunList = z.array(z.unknown()).transform((runs) =>
  runs.flatMap((run) => {
    const parsed = ScheduledRun.safeParse(run)
    return parsed.success ? [parsed.data] : []
  })
)

export type ScheduleTaskBlocker = StartBlocker | 'dependencies-unfinished'

// A task is scheduled to be carried out unattended: one that could only plan would wait on the user.
export function checkScheduleTask(task: Task, dependencies: readonly Pick<Task, 'status'>[]): ScheduleTaskBlocker | null {
  const blocker = checkStart(task, dependencies)
  if (blocker) return blocker
  return startKind(dependencies) === 'plan' ? 'dependencies-unfinished' : null
}

export function isScheduleOpen(run: Pick<ScheduledRun, 'status'>): boolean {
  return run.status === 'waiting' || run.status === 'starting'
}
