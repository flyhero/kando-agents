import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Terminal, type TerminalOutput } from '@kando/protocol'
import type { SessionInfo } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { Rejection } from './rejection'

// The user's own login shell, started the way their terminal app would. An interactive shell is
// the point here; agent commands, by contrast, never go through one.
export function userShell(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: env.COMSPEC ?? 'cmd.exe', args: [] }
  return { command: env.SHELL || '/bin/sh', args: ['-l'] }
}

// An agent's command, run by the user's shell as the user's terminal would, but as the shell's
// command rather than typed at its prompt: the tab ends with the command, and says how it ended.
// The command is the agent's, so a shell has to read it; the agent's own permission prompt, or
// Kando's where the agent has none, is what stands in front of it.
export function commandShell(command: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { command: env.SHELL || '/bin/sh', args: ['-l', '-c', command] }
}

// What a terminal printed, as plain text for a model: colours, cursor moves and titles dropped,
// and a line drawn over with carriage returns (a progress bar) kept as it last stood.
export function plainOutput(raw: string): string {
  const stripped = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
  return stripped.split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1)).join('\n')
}

const DEFAULT_TAIL = 8000

type Row = { id: string; sessionId: string; cwd: string; title: string; createdAt: number; conversationId: string | null; command: string | null; exited: number; exitCode: number | null }

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
    return this.rows().map(({ exited, ...row }) => Terminal.parse({ ...row, exited: exited === 1 }))
  }

  private rows(): Row[] {
    const rows: unknown[] = this.db
      .prepare(`SELECT id, session_id AS sessionId, cwd, title, created_at AS createdAt, conversation_id AS conversationId,
        command, exited, exit_code AS exitCode FROM terminals ORDER BY created_at`)
      .all()
    return rows.flatMap((row) => {
      const parsed = Terminal.extend({ exited: Terminal.shape.createdAt }).safeParse(row)
      return parsed.success ? [{ ...parsed.data, conversationId: parsed.data.conversationId ?? null, command: parsed.data.command ?? null, exitCode: parsed.data.exitCode ?? null }] : []
    })
  }

  // A conversation's own terminal; any other is as good as missing.
  private agentTerminal(conversationId: string, id: string): Row {
    const row = this.rows().find((each) => each.id === id && each.conversationId === conversationId)
    if (!row) throw new Rejection('terminal-not-found', 'no such terminal of this conversation')
    return row
  }

  owns(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM terminals WHERE session_id = ?').get(sessionId) !== undefined
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

  // An agent's command in a tab of its own, in the folder it asked for (else the conversation's).
  async run(conversationId: string, cwd: string, command: string): Promise<Terminal> {
    const folder = path.isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : os.homedir()
    const shell = commandShell(command)
    const { sessionId } = await this.daemon.request('spawn', { command: shell.command, args: shell.args, cwd: folder, env: {}, cols: 120, rows: 32 })
    const title = command.length > 60 ? `${command.slice(0, 59)}…` : command
    const terminal = { id: randomUUID(), sessionId, cwd: folder, title, createdAt: this.now(), conversationId, command }
    this.db.prepare('INSERT INTO terminals (id, session_id, cwd, title, created_at, conversation_id, command) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(terminal.id, terminal.sessionId, terminal.cwd, terminal.title, terminal.createdAt, conversationId, command)
    this.changed()
    return { ...terminal, exited: false, exitCode: null }
  }

  // The end of what an agent's command printed, as plain text, and whether it still runs.
  async read(conversationId: string, id: string, tail = DEFAULT_TAIL): Promise<TerminalOutput> {
    const row = this.agentTerminal(conversationId, id)
    const attached = await this.daemon.request('attach', { sessionId: row.sessionId }).catch(() => null)
    const output = plainOutput(attached?.buffer ?? '').replace(/\n+$/, '')
    const exited = row.exited === 1 || attached?.exited === true
    return {
      id,
      command: row.command ?? row.title,
      output: output.length > tail ? output.slice(-tail) : output,
      truncated: output.length > tail || (attached?.bufferStart ?? 0) > 0,
      running: !exited && attached !== null,
      exitCode: row.exitCode ?? attached?.exitCode ?? null
    }
  }

  // Stops an agent's command, as Ctrl-C would; the tab stays, saying how it ended.
  async stop(conversationId: string, id: string): Promise<void> {
    const row = this.agentTerminal(conversationId, id)
    if (row.exited === 1) return
    await this.daemon.request('kill', { sessionId: row.sessionId })
  }

  // Ends the shell; its row goes at once rather than waiting for the exit event. An agent's
  // command that already ended leaves its output with the daemon until now.
  async kill(id: string): Promise<void> {
    const terminal = this.rows().find((each) => each.id === id)
    if (!terminal) return
    this.remove(terminal.sessionId)
    if (terminal.exited === 1) await this.daemon.request('release', { sessionId: terminal.sessionId }).catch(() => {})
    else await this.daemon.request('kill', { sessionId: terminal.sessionId }).catch(() => {})
  }

  // `exit` in the shell closes its tab, as a terminal app would. An agent's command ending keeps
  // its tab, with the exit code, so its output can still be read.
  handleExit(sessionId: string, exitCode: number | null = null): void {
    const row = this.rows().find((each) => each.sessionId === sessionId)
    if (!row) return
    if (row.conversationId === null) return this.remove(sessionId)
    this.db.prepare('UPDATE terminals SET exited = 1, exit_code = ? WHERE session_id = ?').run(exitCode, sessionId)
    this.changed()
  }

  // A shell the daemon no longer runs is gone; an agent's command stays while the daemon still
  // holds what it printed.
  reconcile(sessions: readonly SessionInfo[]): void {
    const known = new Map(sessions.map((session) => [session.sessionId, session]))
    for (const row of this.rows()) {
      const session = known.get(row.sessionId)
      if (!session || (session.exited && row.conversationId === null)) this.remove(row.sessionId)
      else if (session.exited && row.exited === 0) this.handleExit(row.sessionId, session.exitCode)
    }
  }

  private remove(sessionId: string): void {
    if (this.db.prepare('DELETE FROM terminals WHERE session_id = ?').run(sessionId).changes > 0) this.changed()
  }

  private changed(): void {
    this.emit(this.list())
  }
}
