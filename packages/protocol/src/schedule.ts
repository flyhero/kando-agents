import { z } from 'zod'
import { AgentKind, checkStart, startKind, type StartBlocker, type Task } from './task'

// What a scheduled run does when it comes due: start a task, or go on in a conversation (a task's
// included). A conversation's text may be empty: then a plan waiting there is approved, or the
// agent is told to carry out the plan it has.
export const ScheduledTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('conversation'), conversationId: z.string().uuid(), text: z.string().trim().max(100000) })
])
export type ScheduledTarget = z.infer<typeof ScheduledTarget>

// waiting: for its time, its agent's quota, or another of the agent's runs to finish · starting:
// core is starting it now · started: under way, or done; its chat tells · failed: core gave up,
// error says why · cancelled: by the user, or its target went.
export const SCHEDULE_STATUSES = ['waiting', 'starting', 'started', 'failed', 'cancelled'] as const
export const ScheduleStatus = z.enum(SCHEDULE_STATUSES)
export type ScheduleStatus = z.infer<typeof ScheduleStatus>

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
  settledAt: z.number().nullable()
})
export type ScheduledRun = z.infer<typeof ScheduledRun>

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
