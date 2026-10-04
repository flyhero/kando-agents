import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { Conversation, ConversationMessage, ConversationStage, type AgentKind } from '@kando/protocol'

const lastEnded = (column: string) => `(SELECT ${column} FROM conversation_stages
  WHERE conversation_id = conversations.id AND ended_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1)`
const SELECT = `SELECT id, title, title_locked AS titleLocked, agent, workspace_path AS workspacePath,
  project_paths AS projectPaths,
  managed_workspace AS managedWorkspace, session_id AS sessionId, created_at AS createdAt,
  updated_at AS updatedAt, ${lastEnded('exit_code')} AS lastExitCode, ${lastEnded('ended_at')} AS lastExitAt,
  (SELECT plan_only FROM conversation_stages WHERE conversation_id = conversations.id ORDER BY started_at DESC, rowid DESC LIMIT 1) AS planOnly,
  task_id AS taskId, pinned_at AS pinnedAt, routine_id AS routineId
  FROM conversations`
const STAGE_SELECT = `SELECT id, conversation_id AS conversationId, agent, provider_session_id AS providerSessionId,
  session_id AS sessionId, received_sequence AS receivedSequence, started_at AS startedAt,
  ended_at AS endedAt, exit_code AS exitCode, plan_only AS planOnly FROM conversation_stages`
const MESSAGE_SELECT = `SELECT sequence, conversation_id AS conversationId, stage_id AS stageId,
  role, agent, text, event_key AS eventKey, complete, created_at AS createdAt FROM conversation_messages`

// A model and effort name one agent's catalog, so each agent keeps its own; the permission mode
// and the bypass allowance are the conversation's.
const AgentChoice = z.object({ model: z.string().optional(), effort: z.string().optional() })
const ChatOptions = z.object({
  permissionMode: z.string().optional(),
  allowBypass: z.boolean().optional(),
  claude: AgentChoice.optional(),
  codex: AgentChoice.optional()
}).catch({})
export type ChatOptions = z.infer<typeof ChatOptions>

function conversation(row: Record<string, unknown>): Conversation {
  const { lastExitCode, lastExitAt, ...rest } = row
  return Conversation.parse({ ...rest, projectPaths: JSON.parse(String(row.projectPaths)),
    titleLocked: Boolean(row.titleLocked), managedWorkspace: Boolean(row.managedWorkspace), planOnly: Boolean(row.planOnly),
    lastExit: lastExitAt === null ? null : { code: lastExitCode, at: lastExitAt } })
}
function stage(row: Record<string, unknown>): ConversationStage {
  return ConversationStage.parse({ ...row, planOnly: Boolean(row.planOnly) })
}
function message(row: Record<string, unknown>): ConversationMessage {
  return ConversationMessage.parse({ ...row, complete: Boolean(row.complete) })
}

export class ConversationStore {
  private readonly db: DatabaseSync

  constructor(file: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
  }

  close(): void { this.db.close() }

  list(): Conversation[] {
    return this.db.prepare(`${SELECT} ORDER BY updated_at DESC`).all().map(conversation)
  }

  byTask(taskId: string): Conversation | null {
    const row = this.db.prepare(`${SELECT} WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(taskId)
    return row ? conversation(row) : null
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id)
    return row ? conversation(row) : null
  }

  create(
    agent: AgentKind,
    workspacePath: string,
    projectPaths: readonly string[],
    id: string = randomUUID(),
    projectStarts: Record<string, string> = {},
    task: { id: string; title: string } | null = null,
    // The routine whose run opens it, with the title it is named for good: a routine's
    // conversation is never named after its first message, which is the standing instruction.
    routine: { id: string; title: string } | null = null
  ): Conversation {
    const now = this.now()
    // A task's conversation is named after it for good: its title is the task's.
    const named = task ?? routine
    this.db.prepare(`INSERT INTO conversations
      (id, title, title_locked, agent, workspace_path, project_paths, project_starts, managed_workspace, task_id, routine_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, named?.title ?? '新会话', Number(named !== null), agent, workspacePath, JSON.stringify(projectPaths), JSON.stringify(projectStarts),
      Number(projectPaths.length === 0), task?.id ?? null, routine?.id ?? null, now, now)
    return this.get(id)!
  }

  // The conversations a routine opened, once the routine is gone, are the user's like any other:
  // they go back to the list. Returns the ones changed.
  clearRoutine(routineId: string): Conversation[] {
    const ids = this.db.prepare('SELECT id FROM conversations WHERE routine_id = ?').all(routineId).map((row) => String(row.id))
    this.db.prepare('UPDATE conversations SET routine_id = NULL WHERE routine_id = ?').run(routineId)
    return ids.flatMap((id) => this.get(id) ?? [])
  }

  // Where a task's agent works changes between stages: its projects while it only plans, its
  // worktrees once it runs.
  moveWorkspace(id: string, workspacePath: string, projectPaths: readonly string[]): Conversation {
    this.db.prepare('UPDATE conversations SET workspace_path = ?, project_paths = ?, managed_workspace = ? WHERE id = ?')
      .run(workspacePath, JSON.stringify(projectPaths), Number(projectPaths.length === 0), id)
    return this.get(id)!
  }

  // Empty for a conversation created before these were recorded.
  projectStarts(id: string): Record<string, string> {
    return this.stringMap(id, 'project_starts')
  }

  // A project's changes count from here on, as after the user switched its branch.
  setProjectStart(id: string, projectPath: string, head: string): void {
    this.db.prepare('UPDATE conversations SET project_starts = ? WHERE id = ?')
      .run(JSON.stringify({ ...this.projectStarts(id), [projectPath]: head }), id)
  }

  // The branch each project was switched to since the agent was last told, by project path.
  switchedBranches(id: string): Record<string, string> {
    return this.stringMap(id, 'switched_branches')
  }

  setSwitchedBranches(id: string, branches: Record<string, string>): void {
    this.db.prepare('UPDATE conversations SET switched_branches = ? WHERE id = ?').run(JSON.stringify(branches), id)
  }

  private stringMap(id: string, column: 'project_starts' | 'switched_branches'): Record<string, string> {
    const row = this.db.prepare(`SELECT ${column} AS value FROM conversations WHERE id = ?`).get(id)
    const parsed: unknown = JSON.parse(String(row?.value ?? '{}'))
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
  }

  update(id: string, patch: { title?: string; titleLocked?: boolean; agent?: AgentKind; sessionId?: string | null }): Conversation {
    const entries: Array<[string, string | number | null]> = []
    if (patch.title !== undefined) entries.push(['title', patch.title])
    if (patch.titleLocked !== undefined) entries.push(['title_locked', Number(patch.titleLocked)])
    if (patch.agent !== undefined) entries.push(['agent', patch.agent])
    if (patch.sessionId !== undefined) entries.push(['session_id', patch.sessionId])
    if (entries.length) {
      this.db.prepare(`UPDATE conversations SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value), this.now(), id)
    }
    return this.get(id)!
  }

  // Leaves updated_at alone: pinning is not activity, and would reorder the list by recency.
  setPinned(id: string, pinned: boolean): Conversation {
    this.db.prepare('UPDATE conversations SET pinned_at = ? WHERE id = ?').run(pinned ? this.now() : null, id)
    return this.get(id)!
  }

  chatOptions(id: string): ChatOptions {
    const row = this.db.prepare('SELECT chat_options FROM conversations WHERE id = ?').get(id)
    try {
      return ChatOptions.parse(JSON.parse(String(row?.chat_options ?? '{}')))
    } catch {
      return {}
    }
  }

  setChatOptions(id: string, patch: ChatOptions): void {
    this.db.prepare('UPDATE conversations SET chat_options = ? WHERE id = ?').run(JSON.stringify({ ...this.chatOptions(id), ...patch }), id)
  }

  touch(id: string): Conversation {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(this.now(), id)
    return this.get(id)!
  }

  bySession(sessionId: string): Conversation | null {
    const row = this.db.prepare(`${SELECT} WHERE session_id = ?`).get(sessionId)
    return row ? conversation(row) : null
  }

  stages(id: string): ConversationStage[] {
    return this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? ORDER BY started_at, rowid`).all(id).map((row) => stage(row))
  }

  activeStage(id: string): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1`).get(id)
    return row ? stage(row) : null
  }

  latestStage(id: string, agent: AgentKind): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? AND agent = ? ORDER BY rowid DESC LIMIT 1`).get(id, agent)
    return row ? stage(row) : null
  }

  // The agent's newest chat stage in any conversation.
  latestChatStage(agent: AgentKind): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE agent = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(agent)
    return row ? stage(row) : null
  }

  stage(id: string): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE id = ?`).get(id)
    return row ? stage(row) : null
  }

  startStage(conversationId: string, agent: AgentKind, providerSessionId: string | null, receivedSequence: number, id = randomUUID(), planOnly = false): ConversationStage {
    this.db.prepare(`INSERT INTO conversation_stages
      (id, conversation_id, agent, provider_session_id, received_sequence, started_at, plan_only)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, conversationId, agent, providerSessionId, receivedSequence, this.now(), Number(planOnly))
    return this.stage(id)!
  }


  // How far a chat stage's output has been read, counted like the daemon's offsets.
  chatOffset(id: string): number {
    return Number(this.db.prepare('SELECT chat_offset FROM conversation_stages WHERE id = ?').get(id)?.chat_offset ?? 0)
  }

  setChatOffset(id: string, offset: number): void {
    this.db.prepare('UPDATE conversation_stages SET chat_offset = MAX(chat_offset, ?) WHERE id = ?').run(offset, id)
  }

  attachStage(id: string, sessionId: string): void {
    this.db.prepare('UPDATE conversation_stages SET session_id = ? WHERE id = ?').run(sessionId, id)
  }

  deleteStage(id: string): void {
    this.db.prepare('DELETE FROM conversation_stages WHERE id = ?').run(id)
  }

  endStage(id: string, exitCode: number | null): void {
    this.db.prepare(`UPDATE conversation_stages SET ended_at = ?, exit_code = ?,
      received_sequence = (SELECT COALESCE(MAX(sequence), 0) FROM conversation_messages WHERE conversation_id = conversation_stages.conversation_id)
      WHERE id = ? AND ended_at IS NULL`).run(this.now(), exitCode, id)
  }

  setProviderSession(id: string, providerSessionId: string): void {
    this.db.prepare('UPDATE conversation_stages SET provider_session_id = ? WHERE id = ?').run(providerSessionId, id)
  }

  messages(id: string, after = 0): ConversationMessage[] {
    return this.db.prepare(`${MESSAGE_SELECT} WHERE conversation_id = ? AND sequence > ? ORDER BY sequence`).all(id, after).map(message)
  }

  // The latest matching message per conversation: SQLite takes the bare text column from the
  // row holding MAX(sequence). lower() folds only ASCII, which CJK text does not need.
  // Free conversations only, as list() is.
  searchMessages(query: string): Array<{ conversationId: string; text: string }> {
    return this.db.prepare(`SELECT conversation_id AS conversationId, text, MAX(sequence) AS sequence
      FROM conversation_messages WHERE instr(lower(text), lower(?)) > 0
      AND conversation_id IN (SELECT id FROM conversations WHERE task_id IS NULL) GROUP BY conversation_id`)
      .all(query).map((row) => ({ conversationId: String(row.conversationId), text: String(row.text) }))
  }

  hasProviderMessages(conversationId: string, providerSessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM conversation_messages m JOIN conversation_stages s ON s.id = m.stage_id
      WHERE m.conversation_id = ? AND s.provider_session_id = ? LIMIT 1`).get(conversationId, providerSessionId) !== undefined
  }

  maxSequence(id: string): number {
    return Number(this.db.prepare('SELECT MAX(sequence) AS sequence FROM conversation_messages WHERE conversation_id = ?').get(id)?.sequence ?? 0)
  }

  addMessage(value: Omit<ConversationMessage, 'sequence' | 'createdAt'>): ConversationMessage | null {
    const result = this.db.prepare(`INSERT OR IGNORE INTO conversation_messages
      (conversation_id, stage_id, role, agent, text, event_key, complete, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(value.conversationId, value.stageId, value.role, value.agent, value.text, value.eventKey, Number(value.complete), this.now())
    if (result.changes === 0) return null
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE sequence = ?`).get(Number(result.lastInsertRowid))
    return row ? message(row) : null
  }

  completePendingUsers(stageId: string): void {
    this.db.prepare(`UPDATE conversation_messages SET complete = 1
      WHERE stage_id = ? AND role = 'user' AND complete = 0`).run(stageId)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}
