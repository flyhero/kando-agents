import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { SourceSnapshot, Task, TaskImage, TaskProposal, TaskRepo, TaskSource, type TaskStatus } from '@kando/protocol'

// Append-only: each entry upgrades PRAGMA user_version by one.
export const MIGRATIONS = [
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     details TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     repo_path TEXT,
     agent TEXT,
     worktree_path TEXT,
     branch TEXT,
     session_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX tasks_status ON tasks(status);
   CREATE INDEX tasks_session ON tasks(session_id);`,
  // seed / ripening / ripe collapsed into one pending status.
  `UPDATE tasks SET status = 'pending' WHERE status IN ('seed', 'ripening', 'ripe');`,
  // A task spans several repos, and may wait on other tasks.
  `CREATE TABLE task_repos (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     path TEXT NOT NULL,
     worktree_path TEXT,
     branch TEXT,
     PRIMARY KEY (task_id, position)
   );
   INSERT INTO task_repos (task_id, position, path, worktree_path, branch)
     SELECT id, 0, repo_path, worktree_path, branch FROM tasks WHERE repo_path IS NOT NULL;
   ALTER TABLE tasks DROP COLUMN repo_path;
   ALTER TABLE tasks DROP COLUMN worktree_path;
   ALTER TABLE tasks DROP COLUMN branch;
   CREATE TABLE task_dependencies (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     PRIMARY KEY (task_id, depends_on)
   );
   CREATE INDEX task_dependencies_depends_on ON task_dependencies(depends_on);`,
  // Projects offered again when picking one (see ProjectRegistry), seeded from what tasks already use.
  `CREATE TABLE known_repos (path TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
   INSERT INTO known_repos (path, used_at)
     SELECT r.path, MAX(t.updated_at) FROM task_repos r JOIN tasks t ON t.id = r.task_id GROUP BY r.path;`,
  // Refining sessions, the plan an agent hands back, and what accepting it replaced.
  `ALTER TABLE tasks ADD COLUMN refine_session_id TEXT;
   ALTER TABLE tasks ADD COLUMN proposal TEXT;
   ALTER TABLE tasks ADD COLUMN previous_details TEXT;
   CREATE INDEX tasks_refine_session ON tasks(refine_session_id);`,
  // Redoing a done task: the new task points back at the one it replaces.
  `ALTER TABLE tasks ADD COLUMN derived_from TEXT;
   ALTER TABLE tasks ADD COLUMN abandon_reason TEXT;`,
  // Tasks imported from an issue tracker, and the issues the user chose not to import.
  `ALTER TABLE tasks ADD COLUMN source TEXT;
   CREATE TABLE dismissed_issues (
     kind TEXT NOT NULL,
     key TEXT NOT NULL,
     dismissed_at INTEGER NOT NULL,
     PRIMARY KEY (kind, key)
   );`,
  // Sources became pluggable: a source names its provider and instance (Jira was the only one),
  // and the issue text moved out of the details into its own snapshot.
  `ALTER TABLE tasks ADD COLUMN source_snapshot TEXT;
   UPDATE tasks SET source = json_object(
       'provider', 'jira', 'instance', 'default', 'name', 'Jira',
       'key', json_extract(source, '$.key'), 'url', json_extract(source, '$.url'))
     WHERE source IS NOT NULL AND json_valid(source) AND json_extract(source, '$.kind') = 'jira';
   CREATE TABLE dismissed_issues_v2 (
     provider TEXT NOT NULL,
     instance TEXT NOT NULL,
     key TEXT NOT NULL,
     dismissed_at INTEGER NOT NULL,
     PRIMARY KEY (provider, instance, key)
   );
   INSERT INTO dismissed_issues_v2 (provider, instance, key, dismissed_at)
     SELECT kind, 'default', key, dismissed_at FROM dismissed_issues;
   DROP TABLE dismissed_issues;
   ALTER TABLE dismissed_issues_v2 RENAME TO dismissed_issues;`,
  // Images the user attached to a task, as a JSON list of attachment ids and names.
  `ALTER TABLE tasks ADD COLUMN images TEXT;`,
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, title_locked INTEGER NOT NULL,
     agent TEXT NOT NULL, workspace_path TEXT NOT NULL, managed_workspace INTEGER NOT NULL,
     session_id TEXT, output_offset INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE INDEX conversations_updated ON conversations(updated_at DESC);
   CREATE INDEX conversations_session ON conversations(session_id);
   CREATE TABLE conversation_stages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     agent TEXT NOT NULL, provider_session_id TEXT, session_id TEXT,
     received_sequence INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER
   );
   CREATE INDEX conversation_stages_history ON conversation_stages(conversation_id, started_at DESC);
   CREATE TABLE conversation_messages (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     stage_id TEXT NOT NULL REFERENCES conversation_stages(id) ON DELETE CASCADE,
     role TEXT NOT NULL, agent TEXT NOT NULL, text TEXT NOT NULL,
     event_key TEXT NOT NULL, complete INTEGER NOT NULL, created_at INTEGER NOT NULL,
     UNIQUE(stage_id, event_key)
   );
   CREATE INDEX conversation_messages_history ON conversation_messages(conversation_id, sequence);`,
  `ALTER TABLE conversations ADD COLUMN project_paths TEXT NOT NULL DEFAULT '[]';
   UPDATE conversations SET project_paths = json_array(workspace_path) WHERE managed_workspace = 0;`,
  // How the last run ended, and whether its agent is waiting for the user.
  `ALTER TABLE tasks ADD COLUMN last_exit TEXT;
   ALTER TABLE tasks ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0;`,
  // Each project's HEAD when a conversation started, keyed by path: its later commits are its own.
  `ALTER TABLE conversations ADD COLUMN project_starts TEXT NOT NULL DEFAULT '{}';`,
  // Shells in the app's terminal panel, which the daemon keeps running across core restarts.
  `CREATE TABLE terminals (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL
   );`
]


const SELECT = `SELECT id, title, details, status, agent, session_id AS sessionId,
  refine_session_id AS refineSessionId, proposal, previous_details AS previousDetails,
  derived_from AS derivedFrom, abandon_reason AS abandonReason, source, source_snapshot AS sourceSnapshot, images,
  last_exit AS lastExit, awaiting_input AS awaitingInput, created_at AS createdAt, updated_at AS updatedAt FROM tasks`

// JSON columns and SQLite's 0/1 booleans are converted; everything else maps straight onto Task.
const TaskRow = Task.omit({
  repos: true,
  dependsOn: true,
  proposal: true,
  source: true,
  sourceSnapshot: true,
  images: true,
  lastExit: true,
  awaitingInput: true
}).extend({
  proposal: z.string().nullable(),
  source: z.string().nullable(),
  sourceSnapshot: z.string().nullable(),
  images: z.string().nullable(),
  lastExit: z.string().nullable(),
  awaitingInput: z.number()
})
const TaskImages = z.array(TaskImage)
const LastExit = Task.shape.lastExit.unwrap().unwrap()

// A column that fails to parse reads as empty, but says so: losing where a task came from silently
// would be worse than a noisy log.
function parseColumn<T>(schema: z.ZodType<T>, raw: string | null, where: string): T | null {
  if (raw === null) {
    return null
  }
  const parsed = schema.safeParse(jsonOrUndefined(raw))
  if (!parsed.success) {
    console.error(`[kando-core] unreadable ${where}; treating it as empty`)
    return null
  }
  return parsed.data
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Reported by the schema check that follows, which fails on undefined.
    return undefined
  }
}
const RepoRow = TaskRepo.extend({ taskId: z.string() })
const DependencyRow = z.object({ taskId: z.string(), dependsOn: z.string() })

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'details'
    | 'status'
    | 'agent'
    | 'sessionId'
    | 'refineSessionId'
    | 'proposal'
    | 'previousDetails'
    | 'derivedFrom'
    | 'abandonReason'
    | 'source'
    | 'sourceSnapshot'
    | 'images'
    | 'lastExit'
    | 'awaitingInput'
    | 'repos'
    | 'dependsOn'
  >
>

// Columns on `tasks` itself; repos and dependencies live in their own tables.
const SCALAR_KEYS = [
  'title',
  'details',
  'status',
  'agent',
  'sessionId',
  'refineSessionId',
  'previousDetails',
  'derivedFrom',
  'abandonReason'
] as const

const SCALAR_COLUMNS: Record<(typeof SCALAR_KEYS)[number], string> = {
  title: 'title',
  details: 'details',
  status: 'status',
  agent: 'agent',
  sessionId: 'session_id',
  refineSessionId: 'refine_session_id',
  previousDetails: 'previous_details',
  derivedFrom: 'derived_from',
  abandonReason: 'abandon_reason'
}

function groupBy<T extends { taskId: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  rows.forEach((row) => groups.set(row.taskId, [...(groups.get(row.taskId) ?? []), row]))
  return groups
}

export class TaskStore {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    MIGRATIONS.slice(version).forEach((sql, offset) => {
      this.transaction(() => {
        this.db.exec(sql)
        this.db.exec(`PRAGMA user_version = ${version + offset + 1}`)
      })
    })
  }

  private transaction(write: () => void): void {
    this.db.exec('BEGIN')
    try {
      write()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private many(sql: string, ...params: SQLInputValue[]): Task[] {
    const rows = this.db
      .prepare(sql)
      .all(...params)
      .map((row) => TaskRow.parse(row))
    if (rows.length === 0) {
      return []
    }
    const ids = JSON.stringify(rows.map((row) => row.id))
    const repos = groupBy(
      this.db
        .prepare(
          `SELECT task_id AS taskId, path, worktree_path AS worktreePath, branch FROM task_repos
           WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY position`
        )
        .all(ids)
        .map((row) => RepoRow.parse(row))
    )
    const dependencies = groupBy(
      this.db
        .prepare(
          `SELECT task_id AS taskId, depends_on AS dependsOn FROM task_dependencies
           WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`
        )
        .all(ids)
        .map((row) => DependencyRow.parse(row))
    )
    return rows.map((row) => ({
      ...row,
      proposal: parseColumn(TaskProposal, row.proposal, `proposal of task ${row.id}`),
      source: parseColumn(TaskSource, row.source, `source of task ${row.id}`),
      sourceSnapshot: parseColumn(SourceSnapshot, row.sourceSnapshot, `source snapshot of task ${row.id}`),
      images: parseColumn(TaskImages, row.images, `images of task ${row.id}`) ?? [],
      lastExit: parseColumn(LastExit, row.lastExit, `last exit of task ${row.id}`),
      awaitingInput: row.awaitingInput !== 0,
      repos: (repos.get(row.id) ?? []).map(({ path, worktreePath, branch }) => ({ path, worktreePath, branch })),
      dependsOn: (dependencies.get(row.id) ?? []).map((edge) => edge.dependsOn)
    }))
  }

  list(status?: TaskStatus): Task[] {
    return status
      ? this.many(`${SELECT} WHERE status = ? ORDER BY updated_at DESC`, status)
      : this.many(`${SELECT} ORDER BY updated_at DESC`)
  }

  get(id: string): Task | null {
    return this.many(`${SELECT} WHERE id = ?`, id)[0] ?? null
  }

  // Returns at most two rows: enough to tell "unique" from "ambiguous".
  findByPrefix(prefix: string): Task[] {
    if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) {
      return []
    }
    return this.many(`${SELECT} WHERE id LIKE ? LIMIT 2`, `${prefix.toLowerCase()}%`)
  }

  findBySession(sessionId: string): Task | null {
    return this.many(`${SELECT} WHERE session_id = ?`, sessionId)[0] ?? null
  }

  findByRefineSession(sessionId: string): Task | null {
    return this.many(`${SELECT} WHERE refine_session_id = ?`, sessionId)[0] ?? null
  }

  refining(): Task[] {
    return this.many(`${SELECT} WHERE refine_session_id IS NOT NULL`)
  }

  dependsOn(id: string): string[] {
    return this.db
      .prepare('SELECT depends_on AS dependsOn FROM task_dependencies WHERE task_id = ?')
      .all(id)
      .map((row) => DependencyRow.pick({ dependsOn: true }).parse(row).dependsOn)
  }

  dependents(id: string): Task[] {
    return this.many(`${SELECT} WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on = ?)`, id)
  }

  // Keys of issues the user dismissed from an inbox, so a refresh does not bring them back.
  dismissedIssues(provider: string, instance: string): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT key FROM dismissed_issues WHERE provider = ? AND instance = ?')
        .all(provider, instance)
        .map((row) => z.object({ key: z.string() }).parse(row).key)
    )
  }

  dismissIssue(provider: string, instance: string, key: string): void {
    this.db
      .prepare(
        'INSERT INTO dismissed_issues (provider, instance, key, dismissed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
      )
      .run(provider, instance, key, this.now())
  }

  restoreIssue(provider: string, instance: string, key: string): void {
    this.db.prepare('DELETE FROM dismissed_issues WHERE provider = ? AND instance = ? AND key = ?').run(provider, instance, key)
  }

  create(title: string): Task {
    const id = randomUUID()
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, details, status, created_at, updated_at)
         VALUES (?, ?, '', 'pending', ?, ?)`
      )
      .run(id, title, at, at)
    return this.require(id)
  }

  update(id: string, patch: TaskPatch): Task {
    this.transaction(() => {
      const sets: string[] = []
      const values: SQLInputValue[] = []
      for (const key of SCALAR_KEYS) {
        const value = patch[key]
        if (value !== undefined) {
          sets.push(`${SCALAR_COLUMNS[key]} = ?`)
          values.push(value)
        }
      }
      if (patch.proposal !== undefined) {
        sets.push('proposal = ?')
        values.push(patch.proposal === null ? null : JSON.stringify(patch.proposal))
      }
      if (patch.source !== undefined) {
        sets.push('source = ?')
        values.push(patch.source === null ? null : JSON.stringify(patch.source))
      }
      if (patch.images !== undefined) {
        sets.push('images = ?')
        values.push(JSON.stringify(patch.images))
      }
      if (patch.sourceSnapshot !== undefined) {
        sets.push('source_snapshot = ?')
        values.push(patch.sourceSnapshot === null ? null : JSON.stringify(patch.sourceSnapshot))
      }
      if (patch.lastExit !== undefined) {
        sets.push('last_exit = ?')
        values.push(patch.lastExit === null ? null : JSON.stringify(patch.lastExit))
      }
      if (patch.awaitingInput !== undefined) {
        sets.push('awaiting_input = ?')
        values.push(Number(patch.awaitingInput))
      }
      sets.push('updated_at = ?')
      values.push(this.now())
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)

      if (patch.repos) {
        this.db.prepare('DELETE FROM task_repos WHERE task_id = ?').run(id)
        const insert = this.db.prepare(
          'INSERT INTO task_repos (task_id, position, path, worktree_path, branch) VALUES (?, ?, ?, ?, ?)'
        )
        patch.repos.forEach((repo, position) => insert.run(id, position, repo.path, repo.worktreePath, repo.branch))
      }
      if (patch.dependsOn) {
        this.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(id)
        const insert = this.db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)')
        patch.dependsOn.forEach((dependency) => insert.run(id, dependency))
      }
    })
    return this.require(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
  }

  close(): void {
    this.db.close()
  }

  private require(id: string): Task {
    const task = this.get(id)
    if (!task) {
      throw new Error(`task ${id} vanished during write`)
    }
    return task
  }
}
