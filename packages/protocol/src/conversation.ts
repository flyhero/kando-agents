import { z } from 'zod'
import { AgentKind } from './task'

export const Conversation = z.object({
  id: z.string().uuid(),
  title: z.string(),
  titleLocked: z.boolean(),
  agent: AgentKind,
  // PTY cwd: the first selected project, or the managed directory when no project is selected.
  workspacePath: z.string(),
  projectPaths: z.array(z.string()),
  managedWorkspace: z.boolean(),
  sessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
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
  exitCode: z.number().nullable()
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
// branch is null when the folder is not in a git repo.
export const ProjectHead = z.object({ path: z.string(), branch: z.string().nullable(), detached: z.boolean() })
export type ProjectHead = z.infer<typeof ProjectHead>
