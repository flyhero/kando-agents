import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Conversation, ConversationMessage, ConversationStage, type AgentKind } from '@kando/protocol'

const lastEnded = (column: string) => `(SELECT ${column} FROM conversation_stages
  WHERE conversation_id = conversations.id AND ended_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1)`
const SELECT = `SELECT id, title, title_locked AS titleLocked, agent, workspace_path AS workspacePath,
  project_paths AS projectPaths,
  managed_workspace AS managedWorkspace, session_id AS sessionId, created_at AS createdAt,
  updated_at AS updatedAt, ${lastEnded('exit_code')} AS lastExitCode, ${lastEnded('ended_at')} AS lastExitAt
  FROM conversations`
const STAGE_SELECT = `SELECT id, conversation_id AS conversationId, agent, provider_session_id AS providerSessionId,
  session_id AS sessionId, received_sequence AS receivedSequence, started_at AS startedAt,
  ended_at AS endedAt, exit_code AS exitCode FROM conversation_stages`
const MESSAGE_SELECT = `SELECT sequence, conversation_id AS conversationId, stage_id AS stageId,
  role, agent, text, event_key AS eventKey, complete, created_at AS createdAt FROM conversation_messages`

function conversation(row: Record<string, unknown>): Conversation {
  const { lastExitCode, lastExitAt, ...rest } = row
  return Conversation.parse({ ...rest, projectPaths: JSON.parse(String(row.projectPaths)),
    titleLocked: Boolean(row.titleLocked), managedWorkspace: Boolean(row.managedWorkspace),
    lastExit: lastExitAt === null ? null : { code: lastExitCode, at: lastExitAt } })
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

  get(id: string): Conversation | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id)
    return row ? conversation(row) : null
  }

  create(agent: AgentKind, workspacePath: string, projectPaths: readonly string[], id = randomUUID(), projectStarts: Record<string, string> = {}): Conversation {
    const now = this.now()
    this.db.prepare(`INSERT INTO conversations
      (id, title, title_locked, agent, workspace_path, project_paths, project_starts, managed_workspace, created_at, updated_at)
      VALUES (?, '新会话', 0, ?, ?, ?, ?, ?, ?, ?)`).run(id, agent, workspacePath, JSON.stringify(projectPaths), JSON.stringify(projectStarts), Number(projectPaths.length === 0), now, now)
    return this.get(id)!
  }

  // Empty for a conversation created before these were recorded.
  projectStarts(id: string): Record<string, string> {
    const row = this.db.prepare('SELECT project_starts FROM conversations WHERE id = ?').get(id)
    const parsed: unknown = JSON.parse(String(row?.project_starts ?? '{}'))
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
  }

  update(id: string, patch: { title?: string; titleLocked?: boolean; agent?: AgentKind; sessionId?: string | null; outputOffset?: number }): Conversation {
    const entries: Array<[string, string | number | null]> = []
    if (patch.title !== undefined) entries.push(['title', patch.title])
    if (patch.titleLocked !== undefined) entries.push(['title_locked', Number(patch.titleLocked)])
    if (patch.agent !== undefined) entries.push(['agent', patch.agent])
    if (patch.sessionId !== undefined) entries.push(['session_id', patch.sessionId])
    if (patch.outputOffset !== undefined) entries.push(['output_offset', patch.outputOffset])
    if (entries.length) {
      this.db.prepare(`UPDATE conversations SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value), this.now(), id)
    }
    return this.get(id)!
  }

  outputOffset(id: string): number {
    const row = this.db.prepare('SELECT output_offset FROM conversations WHERE id = ?').get(id)
    return Number(row?.output_offset ?? 0)
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
    return this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? ORDER BY started_at, rowid`).all(id).map((row) => ConversationStage.parse(row))
  }

  activeStage(id: string): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1`).get(id)
    return row ? ConversationStage.parse(row) : null
  }

  latestStage(id: string, agent: AgentKind): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE conversation_id = ? AND agent = ? ORDER BY rowid DESC LIMIT 1`).get(id, agent)
    return row ? ConversationStage.parse(row) : null
  }

  stage(id: string): ConversationStage | null {
    const row = this.db.prepare(`${STAGE_SELECT} WHERE id = ?`).get(id)
    return row ? ConversationStage.parse(row) : null
  }

  startStage(conversationId: string, agent: AgentKind, providerSessionId: string | null, receivedSequence: number, id = randomUUID()): ConversationStage {
    this.db.prepare(`INSERT INTO conversation_stages
      (id, conversation_id, agent, provider_session_id, received_sequence, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, conversationId, agent, providerSessionId, receivedSequence, this.now())
    return this.stage(id)!
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
  searchMessages(query: string): Array<{ conversationId: string; text: string }> {
    return this.db.prepare(`SELECT conversation_id AS conversationId, text, MAX(sequence) AS sequence
      FROM conversation_messages WHERE instr(lower(text), lower(?)) > 0 GROUP BY conversation_id`)
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
