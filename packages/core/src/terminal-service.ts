import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Terminal } from '@kando/protocol'
import type { SessionInfo } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'

// The user's own login shell, started the way their terminal app would. An interactive shell is
// the point here; agent commands, by contrast, never go through one.
export function userShell(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: env.COMSPEC ?? 'cmd.exe', args: [] }
  return { command: env.SHELL || '/bin/sh', args: ['-l'] }
}

// Rows live in `terminals`, which TaskStore's migrations create. They outlive a core restart
// because the daemon keeps the shells running; reconcile drops the ones it no longer has.
export class TerminalService {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly daemon: SessionHost,
    private readonly emit: (terminals: Terminal[]) => void,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  list(): Terminal[] {
    return this.db
      .prepare('SELECT id, session_id AS sessionId, cwd, title, created_at AS createdAt FROM terminals ORDER BY created_at')
      .all()
      .map((row) => Terminal.parse(row))
  }

  // In the folder the user is looking at when there is one, else their home.
  async open(cwd: string | undefined): Promise<Terminal> {
    const folder = cwd && path.isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : os.homedir()
    const shell = userShell()
    const { sessionId } = await this.daemon.request('spawn', { command: shell.command, args: shell.args, cwd: folder, env: {}, cols: 100, rows: 30 })
    const terminal = { id: randomUUID(), sessionId, cwd: folder, title: path.basename(folder) || folder, createdAt: this.now() }
    this.db.prepare('INSERT INTO terminals (id, session_id, cwd, title, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(terminal.id, terminal.sessionId, terminal.cwd, terminal.title, terminal.createdAt)
    this.changed()
    return terminal
  }

  // Ends the shell; its row goes at once rather than waiting for the exit event.
  async kill(id: string): Promise<void> {
    const terminal = this.list().find((each) => each.id === id)
    if (!terminal) return
    this.remove(terminal.sessionId)
    await this.daemon.request('kill', { sessionId: terminal.sessionId }).catch(() => {})
  }

  // `exit` in the shell closes its tab, as a terminal app would.
  handleExit(sessionId: string): void {
    this.remove(sessionId)
  }

  reconcile(sessions: readonly SessionInfo[]): void {
    const live = new Set(sessions.filter((session) => !session.exited).map((session) => session.sessionId))
    const gone = this.list().filter((terminal) => !live.has(terminal.sessionId))
    gone.forEach((terminal) => this.remove(terminal.sessionId))
  }

  private remove(sessionId: string): void {
    if (this.db.prepare('DELETE FROM terminals WHERE session_id = ?').run(sessionId).changes > 0) this.changed()
  }

  private changed(): void {
    this.emit(this.list())
  }
}
