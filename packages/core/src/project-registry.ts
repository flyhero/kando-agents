import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { normalizeRepoPath } from './workspace'

const RECENT_LIMIT = 50

// The projects tasks and conversations have used, most recent first, offered again when
// picking one. Rows live in known_repos, which TaskStore's migrations create and seed.
export class ProjectRegistry {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  recent(): string[] {
    return this.db
      .prepare('SELECT path FROM known_repos ORDER BY used_at DESC LIMIT ?')
      .all(RECENT_LIMIT)
      .map((row) => z.object({ path: z.string() }).parse(row).path)
  }

  remember(paths: readonly string[]): void {
    if (paths.length === 0) return
    const upsert = this.db.prepare(
      'INSERT INTO known_repos (path, used_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET used_at = excluded.used_at'
    )
    const at = this.now()
    this.db.exec('BEGIN')
    try {
      paths.forEach((projectPath) => upsert.run(normalizeRepoPath(projectPath), at))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Only stops offering it: tasks and conversations that use it keep it.
  forget(projectPath: string): void {
    this.db.prepare('DELETE FROM known_repos WHERE path = ?').run(normalizeRepoPath(projectPath))
  }
}
