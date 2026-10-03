import { z } from 'zod'
import { ChatTurnActivity } from './chat'
import { AgentKind } from './task'

export const Conversation = z.object({
  id: z.string().uuid(),
  title: z.string(),
  titleLocked: z.boolean(),
  agent: AgentKind,
  // The agent's cwd: the first selected project, or the managed directory when no project is selected.
  workspacePath: z.string(),
  // Ordered: primary project first, followed by additional directories.
  projectPaths: z.array(z.string()),
  managedWorkspace: z.boolean(),
  sessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // How the agent last stopped: code is null when it was stopped rather than exiting on its own.
  // null before any run has ended. Older cores leave it out.
  lastExit: z.object({ code: z.number().int().nullable(), at: z.number() }).nullable().optional(),
  // Set while a chat-mode agent is running, to tell whether it works or waits on the user.
  // suggestion: what the agent predicts the user will type next, once a turn has ended, until the
  // next message; only when the user has them on. Older cores leave it out.
  chat: z.object({ turn: ChatTurnActivity.catch('idle'), suggestion: z.string().nullable().optional() }).nullable().optional(),
  // What the next chat stage starts with, as chosen or as the last stage left it: the permission
  // mode, and the model and effort of the conversation's agent. Older cores leave it out.
  chatOptions: z.object({
    permissionMode: z.string().nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable()
  }).optional(),
  // The task this conversation runs, which keeps it out of the free conversations. Older cores leave it out.
  taskId: z.string().nullable().optional(),
  // Whether its latest stage may only plan: read-only, the plan kept rather than carried out.
  planOnly: z.boolean().optional()
})
export type Conversation = z.infer<typeof Conversation>

export const ConversationStage = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  agent: AgentKind,
  providerSessionId: z.string().nullable(),
  sessionId: z.string().nullable(),
  receivedSequence: z.number().int().nonnegative(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
  // A stage that may only plan (see Conversation.planOnly).
  planOnly: z.boolean().optional()
})
export type ConversationStage = z.infer<typeof ConversationStage>

export const ConversationMessage = z.object({
  sequence: z.number().int().positive(),
  conversationId: z.string().uuid(),
  stageId: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  agent: AgentKind,
  text: z.string(),
  eventKey: z.string(),
  complete: z.boolean(),
  createdAt: z.number()
})
export type ConversationMessage = z.infer<typeof ConversationMessage>

// A conversation whose messages contain a search query, with the text around the latest match.
export const ConversationSearchHit = z.object({ conversationId: z.string().uuid(), snippet: z.string() })
export type ConversationSearchHit = z.infer<typeof ConversationSearchHit>

// What a project folder has checked out: a branch, or a short commit id when HEAD is detached.
// branch is null when the folder is not in a git repo. Older cores send no status fields.
export const ProjectHead = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  // The tracked remote branch, null when there is none; ahead and behind count against it.
  upstream: z.string().nullable().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  // Uncommitted entries, untracked files included.
  changes: z.number().int().nonnegative().optional()
})
export type ProjectHead = z.infer<typeof ProjectHead>

export const CommitPushResult = z.object({
  commit: z.string(),
  branch: z.string(),
  upstream: z.string()
})
export type CommitPushResult = z.infer<typeof CommitPushResult>

// What a conversation's project could switch to, or start a branch from: its checkout is the
// user's own, so a switch changes what everything else in that folder sees too.
export const ProjectBranches = z.object({
  path: z.string(),
  git: z.boolean(),
  // The branch checked out; null when HEAD is detached or there is no git.
  branch: z.string().nullable(),
  // Uncommitted changes to tracked files, which keep a switch from happening.
  changes: z.number().int().nonnegative(),
  // Local branches, then remote-tracking ones, by full name.
  refs: z.array(z.string()),
  // Branches another worktree has checked out, which git will not check out here as well: the
  // full name, and that worktree's folder.
  elsewhere: z.record(z.string(), z.string()),
  // Other conversations with an agent open in this folder, by title: a switch moves their files too.
  sharedWith: z.array(z.string())
})
export type ProjectBranches = z.infer<typeof ProjectBranches>

export type BranchSwitchBlocker = 'task-conversation' | 'chat-busy'

// A switch changes the files under the agent, so it waits for the agent to be idle. A task's
// conversation runs in the task's worktrees, whose branch is its.
export function checkSwitchBranch(conversation: Pick<Conversation, 'taskId' | 'sessionId' | 'chat'>): BranchSwitchBlocker | null {
  if (conversation.taskId) return 'task-conversation'
  if (!conversation.sessionId) return null
  return conversation.chat?.turn === 'idle' ? null : 'chat-busy'
}

export type AdditionalProjectsBlocker = BranchSwitchBlocker | 'managed-workspace'

// The agent is given its directories at launch, so a change restarts it on the same session once
// it is idle. The primary is the cwd the session began in and stays. A conversation begun without
// projects works in a directory of Kando's own; a task's has its projects set on the task.
export function checkEditAdditionalProjects(
  conversation: Pick<Conversation, 'taskId' | 'sessionId' | 'chat' | 'managedWorkspace'>
): AdditionalProjectsBlocker | null {
  if (conversation.taskId) return 'task-conversation'
  if (conversation.managedWorkspace) return 'managed-workspace'
  return checkSwitchBranch(conversation)
}
