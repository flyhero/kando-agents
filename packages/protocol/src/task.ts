import { z } from 'zod'
import { AgentKind } from './agent'
import { TaskImage } from './attachments'
import { TaskLaunchOptions, type ChatTurnActivity } from './chat'
import { SourceSnapshot, TaskSource } from './source'

// pending: not handed to an agent yet · running: an agent works on it in the task's chat
// review: handed in, and the user has not judged the result · done: the user accepted it,
// or closed the task themselves · abandoned: redone as a new task
export const TASK_STATUSES = ['pending', 'running', 'review', 'done', 'abandoned'] as const
export const TaskStatus = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof TaskStatus>

export { AGENT_KINDS, AgentKind } from './agent'

export const MAX_TASK_REPOS = 10
export const MAX_DETAILS_LENGTH = 100_000

// A plan the agent proposed in the task's chat and the user kept: approved to carry out, or saved
// while the tasks it builds on were unfinished. Kept apart from the details, which stay the user's.
export const TaskPlan = z.object({
  markdown: z.string(),
  agent: AgentKind,
  approved: z.boolean(),
  // The chat item it came from, which the chat marks as kept; null when it has none.
  stageId: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.number()
})
export type TaskPlan = z.infer<typeof TaskPlan>

// What a task's branch may be picked to start from: a local or remote-tracking branch by its full
// name, or HEAD for whatever the project has checked out.
export const START_HEAD = 'HEAD'

export function isStartRef(ref: string): boolean {
  return ref === START_HEAD || /^refs\/(heads|remotes)\/[^\s]+$/.test(ref)
}

// Why a branch did not start from the latest of what it was meant to: fetching failed, so the local
// copy was used, or the repo has no origin default branch, so it started from HEAD.
export const StartNote = z.enum(['fetch-failed', 'no-remote-default'])
export type StartNote = z.infer<typeof StartNote>

// Where a task's branch started in one repo, recorded when Kando made the branch.
export const TaskStart = z.object({
  // As a person names it: origin/main, release/2.4, or the branch the project was on.
  ref: z.string(),
  commit: z.string(),
  note: StartNote.nullable().catch(null),
  at: z.number()
})
export type TaskStart = z.infer<typeof TaskStart>

export const TaskRepo = z.object({
  // Absolute path of the repo (or plain folder) the user picked.
  path: z.string(),
  // Filled in by the first run and reused by later ones.
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  // What the user picked for this task's branch to start from. Null is the branch a dependency
  // left in the repo, when exactly one did, and otherwise origin's default branch.
  startRef: z.string().nullable().default(null),
  start: TaskStart.nullable().default(null)
})
export type TaskRepo = z.infer<typeof TaskRepo>

// What one of a task's repos could start from, for picking.
export const RepoStartOptions = z.object({
  path: z.string(),
  git: z.boolean(),
  // The branch the project has checked out, or its short commit when detached.
  current: z.string().nullable(),
  // What starts the branch when nothing is picked, by full name; null falls back to HEAD.
  fallback: z.string().nullable(),
  // Whether that is a dependency's branch rather than origin's default.
  stacked: z.boolean(),
  // Local branches, then remote-tracking ones, by full name.
  refs: z.array(z.string())
})
export type RepoStartOptions = z.infer<typeof RepoStartOptions>

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  details: z.string(),
  status: TaskStatus,
  // Ordered: the first repo is primary; its working directory is the agent's cwd.
  repos: z.array(TaskRepo),
  // Ids of tasks that must be done before this one can run.
  dependsOn: z.array(z.string()),
  agent: AgentKind.nullable(),
  // The abandoned task this one redoes.
  derivedFrom: z.string().nullable().default(null),
  // Why an abandoned task was given up, handed to the agent that redoes it.
  abandonReason: z.string().nullable().default(null),
  // The issue a task was imported from, and that issue's text as fetched.
  source: TaskSource.nullable().default(null),
  sourceSnapshot: SourceSnapshot.nullable().default(null),
  // Images the user attached, in order; kept out of the details so those stay plain text.
  images: z.array(TaskImage).default([]),
  // The agent has finished its turn and waits for the user.
  awaitingInput: z.boolean().default(false),
  // The chat the task runs in, made when it starts; null before then.
  conversationId: z.string().nullable().default(null),
  plan: TaskPlan.nullable().default(null),
  // The mode, model and effort a start by hand uses when it names none; a scheduled run takes the
  // model and effort, and the unattended mode. Older cores leave it out.
  launch: TaskLaunchOptions.default({}),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Task = z.infer<typeof Task>

export type ProjectEditBlocker = 'task-running' | 'task-abandoned' | 'run-in-progress'

export function checkEditProjects(task: Pick<Task, 'status'>, launching = false): ProjectEditBlocker | null {
  if (launching) return 'run-in-progress'
  if (task.status === 'running') return 'task-running'
  return task.status === 'abandoned' ? 'task-abandoned' : null
}

export type StartEditBlocker = ProjectEditBlocker | 'branch-exists'

// A start only matters until the branch exists: a worktree laid out again keeps its branch.
export function checkEditStart(
  task: Pick<Task, 'status'>,
  repo: Pick<TaskRepo, 'branch'>,
  launching = false
): StartEditBlocker | null {
  return checkEditProjects(task, launching) ?? (repo.branch ? 'branch-exists' : null)
}

export type PrimaryChangeBlocker = 'primary-fixed'

// An agent's session keeps the cwd it began in, and a task's chat is one session from its first
// message on: from then, the primary project stays. Additional projects still come and go, as an
// agent can be given another directory mid-session.
export function checkChangePrimary(task: Pick<Task, 'conversationId'>): PrimaryChangeBlocker | null {
  return task.conversationId ? 'primary-fixed' : null
}

// `running` is entered only by starting or continuing, `review` only by the task being handed in
// (its agent does not end with the work), and `abandoned` only by
// redoing. A finished task never goes back to pending: it continues in place, or is redone from
// scratch. Moving to done is the user's say-so: accepting a result under review,
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

export type MoveBlocker = 'invalid-transition'

export function checkMove(task: Task, to: TaskStatus): MoveBlocker | null {
  return MANUAL_MOVES[task.status].includes(to) ? null : 'invalid-transition'
}

// How a task starts: planning in a worktree and then carrying the plan out once what it builds
// on is done, or only planning, read-only in the projects, while it is not. `dependencies` are the
// tasks listed in `task.dependsOn`; only an accepted (done) one counts, as one under review may
// have failed.
export type StartKind = 'execute' | 'plan'

export function startKind(dependencies: readonly Pick<Task, 'status'>[]): StartKind {
  return dependencies.every((dependency) => dependency.status === 'done') ? 'execute' : 'plan'
}

export function checkStartMode(dependencies: readonly Pick<Task, 'status'>[], mode: string): 'dependencies-unfinished' | null {
  return mode !== 'plan' && startKind(dependencies) === 'plan' ? 'dependencies-unfinished' : null
}

// planning: the task's read-only chat is open and it still cannot run; it goes on by message.
export type StartBlocker = 'not-pending' | 'missing-repo' | 'missing-agent' | 'planning'

export function checkStart(task: Task, dependencies: readonly Pick<Task, 'status'>[]): StartBlocker | null {
  if (task.status !== 'pending') {
    return 'not-pending'
  }
  if (task.repos.length === 0) {
    return 'missing-repo'
  }
  if (!task.agent) {
    return 'missing-agent'
  }
  return task.conversationId && startKind(dependencies) === 'plan' ? 'planning' : null
}

export type SubmitBlocker = 'not-running' | 'not-chat' | 'agent-working'

// A chat task goes for review when the user hands it in, never while its agent is mid-turn.
export function checkSubmit(task: Task, turn: ChatTurnActivity | null): SubmitBlocker | null {
  if (task.status !== 'running') {
    return 'not-running'
  }
  if (!task.conversationId) {
    return 'not-chat'
  }
  return turn === 'running' || turn === 'awaiting' ? 'agent-working' : null
}

export type ChatResumeBlocker = 'no-chat' | 'abandoned' | 'not-done' | 'missing-repo' | 'missing-agent' | 'blocked'

// A message to a chat task goes on with it: planning while pending, working while running, and
// reopening a finished one as continuing does.
export function checkChatResume(task: Task, dependencies: readonly Pick<Task, 'status'>[]): ChatResumeBlocker | null {
  if (!task.conversationId) {
    return 'no-chat'
  }
  if (task.status === 'abandoned') {
    return 'abandoned'
  }
  if (isFinished(task.status)) {
    return checkContinue(task, dependencies)
  }
  if (task.repos.length === 0) {
    return 'missing-repo'
  }
  return task.agent ? null : 'missing-agent'
}

export type TaskHandoffBlocker = ChatResumeBlocker | 'chat-busy'

// A task's chat goes to another agent where a message could go on with it, once its agent is idle:
// the new one picks up from what was said, so a turn cut short would be lost on the way.
export function checkTaskHandoff(task: Task, dependencies: readonly Pick<Task, 'status'>[], turn: ChatTurnActivity | null): TaskHandoffBlocker | null {
  const blocker = checkChatResume(task, dependencies)
  if (blocker) return blocker
  return turn === 'running' || turn === 'awaiting' ? 'chat-busy' : null
}

export type SavePlanBlocker = 'not-pending' | 'no-chat'

// Only a task that cannot run yet keeps a plan for later; a running one carries its plan out.
export function checkSavePlan(task: Task): SavePlanBlocker | null {
  if (task.status !== 'pending') {
    return 'not-pending'
  }
  return task.conversationId ? null : 'no-chat'
}

export type ContinueBlocker = 'not-done' | 'missing-repo' | 'missing-agent' | 'blocked'

// Continuing picks the finished work up again in its own worktree: under review, to change what
// the user found wrong; once accepted, to reopen it. It does so with the next message of its chat.
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

// The agent's work was handed in, accepted or not.
export function isFinished(status: TaskStatus): boolean {
  return status === 'review' || status === 'done'
}

export function taskPrompt(task: Pick<Task, 'title' | 'details'>): string {
  return `${task.title}\n\n${task.details}`.trim()
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8)
}
