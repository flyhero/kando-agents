import { z } from 'zod'
import { TaskImage } from './attachments'
import { SourceSnapshot, TaskSource } from './source'

// pending: not handed to an agent yet · running: an agent session owns it
// review: the session ended and the user has not judged the result · done: the user accepted it,
// or closed the task themselves · abandoned: redone as a new task
export const TASK_STATUSES = ['pending', 'running', 'review', 'done', 'abandoned'] as const
export const TaskStatus = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof TaskStatus>

// A task's two kinds of agent session: the run (or continuation) that does the work, and refining.
export const TaskSession = z.enum(['run', 'refine'])
export type TaskSession = z.infer<typeof TaskSession>

export const AGENT_KINDS = ['claude', 'codex'] as const
export const AgentKind = z.enum(AGENT_KINDS)
export type AgentKind = z.infer<typeof AgentKind>

export const MAX_TASK_REPOS = 10
export const MAX_DETAILS_LENGTH = 100_000

// MCP tools a refining agent gets: one hands its plan back, one reads what it builds on.
export const PROPOSE_DETAILS_TOOL = 'propose_task_details'
export const READ_TASK_TOOL = 'read_task_details'

export const TaskProposal = z.object({
  markdown: z.string(),
  agent: AgentKind.nullable(),
  createdAt: z.number()
})
export type TaskProposal = z.infer<typeof TaskProposal>

export const TaskRepo = z.object({
  // Absolute path of the repo (or plain folder) the user picked.
  path: z.string(),
  // Filled in by the first run and reused by later ones.
  worktreePath: z.string().nullable(),
  branch: z.string().nullable()
})
export type TaskRepo = z.infer<typeof TaskRepo>

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  details: z.string(),
  status: TaskStatus,
  repos: z.array(TaskRepo),
  // Ids of tasks that must be done before this one can run.
  dependsOn: z.array(z.string()),
  agent: AgentKind.nullable(),
  sessionId: z.string().nullable(),
  // Defaults keep a newer client readable against an older core that lacks these.
  // Set while a refining session (read-only, talking the task through) is open.
  refineSessionId: z.string().nullable().default(null),
  // Details an agent proposed, waiting for the user to accept or drop them.
  proposal: TaskProposal.nullable().default(null),
  // What the last accepted proposal replaced; undoable until the details are edited again.
  previousDetails: z.string().nullable().default(null),
  // The abandoned task this one redoes.
  derivedFrom: z.string().nullable().default(null),
  // Why an abandoned task was given up, handed to the agent that redoes it.
  abandonReason: z.string().nullable().default(null),
  // The issue a task was imported from, and that issue's text as fetched.
  source: TaskSource.nullable().default(null),
  sourceSnapshot: SourceSnapshot.nullable().default(null),
  // Images the user attached, in order; kept out of the details so those stay plain text.
  images: z.array(TaskImage).default([]),
  // How the last run or continuation ended: the agent's exit code, or null when core found the
  // session already gone (the daemon restarted, say) and cannot tell. Null while none has ended.
  lastExit: z.object({ code: z.number().nullable() }).nullable().default(null),
  // The agent has finished its turn and waits for the user; its hooks set this, input clears it.
  awaitingInput: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Task = z.infer<typeof Task>

// `running` is entered only by running or continuing, `review` only by a session ending, and
// `abandoned` only by redoing. A finished task never goes back to pending: it continues in place,
// or is redone from scratch. Moving to done is the user's say-so: accepting a result under review,
// or closing a task whose work was finished some other way.
const MANUAL_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['done'],
  running: ['done'],
  review: ['done'],
  done: [],
  abandoned: []
}

export function manualMoves(from: TaskStatus): readonly TaskStatus[] {
  return MANUAL_MOVES[from]
}

export type MoveBlocker = 'invalid-transition' | 'refining'

export function checkMove(task: Task, to: TaskStatus): MoveBlocker | null {
  if (!MANUAL_MOVES[task.status].includes(to)) {
    return 'invalid-transition'
  }
  // Closing the task would strand the agent it is being refined with.
  return task.refineSessionId ? 'refining' : null
}

export type RunBlocker = 'not-pending' | 'refining' | 'missing-repo' | 'missing-agent' | 'blocked'

// `dependencies` are the tasks listed in `task.dependsOn`. Only an accepted (done) dependency lets
// its dependents run: one under review may have failed.
export function checkRun(task: Task, dependencies: readonly Pick<Task, 'status'>[]): RunBlocker | null {
  if (task.status !== 'pending') {
    return 'not-pending'
  }
  // Two agents in the same worktree would talk past each other.
  if (task.refineSessionId) {
    return 'refining'
  }
  if (task.repos.length === 0) {
    return 'missing-repo'
  }
  if (!task.agent) {
    return 'missing-agent'
  }
  if (dependencies.some((dependency) => dependency.status !== 'done')) {
    return 'blocked'
  }
  return null
}

export type RefineBlocker = 'not-pending' | 'refine-in-progress' | 'missing-repo' | 'missing-agent'

// Refining only needs somewhere to read code and someone to talk to; unfinished
// dependencies do not matter yet.
export type ContinueBlocker = 'not-done' | 'missing-repo' | 'missing-agent' | 'blocked'

// Continuing picks the finished work up again in its own worktree: under review, to change what
// the user found wrong; once accepted, to reopen it.
export function checkContinue(task: Task, dependencies: readonly Pick<Task, 'status'>[]): ContinueBlocker | null {
  if (!isFinished(task.status)) {
    return 'not-done'
  }
  if (task.repos.length === 0) {
    return 'missing-repo'
  }
  if (!task.agent) {
    return 'missing-agent'
  }
  return dependencies.some((dependency) => dependency.status !== 'done') ? 'blocked' : null
}

export type RedoBlocker = 'not-done'

export function checkRedo(task: Task): RedoBlocker | null {
  return isFinished(task.status) ? null : 'not-done'
}

// A session has ended and left work behind, accepted or not.
export function isFinished(status: TaskStatus): boolean {
  return status === 'review' || status === 'done'
}

export function checkRefine(task: Task): RefineBlocker | null {
  if (task.status !== 'pending') {
    return 'not-pending'
  }
  if (task.refineSessionId) {
    return 'refine-in-progress'
  }
  if (task.repos.length === 0) {
    return 'missing-repo'
  }
  return task.agent ? null : 'missing-agent'
}

export function taskPrompt(task: Pick<Task, 'title' | 'details'>): string {
  return `${task.title}\n\n${task.details}`.trim()
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8)
}
