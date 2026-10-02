import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { MAX_TERMINAL_COMMANDS, TerminalCommand } from '@kando/protocol'
import { Rejection } from './rejection'

type Fields = Pick<TerminalCommand, 'label' | 'command' | 'run' | 'projectPath'>

const SELECT = `SELECT id, label, command, run, project_path AS projectPath, created_at AS createdAt
  FROM terminal_commands ORDER BY created_at, rowid`
const Row = TerminalCommand.extend({ run: z.number().transform((run) => run === 1) })

// Rows live in `terminal_commands`, which TaskStore's migrations create.
export class TerminalCommandStore {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly emit: (commands: TerminalCommand[]) => void,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  list(): TerminalCommand[] {
    return this.db.prepare(SELECT).all().map((row) => Row.parse(row))
  }

  save(fields: Fields & { id?: string }): TerminalCommand {
    const { id, label, command, run, projectPath } = fields
    if (id) {
      const changed = this.db
        .prepare('UPDATE terminal_commands SET label = ?, command = ?, run = ?, project_path = ? WHERE id = ?')
        .run(label, command, run ? 1 : 0, projectPath, id).changes
      if (changed === 0) throw new Rejection('terminal_command_not_found', '这条常用命令已经被删除了')
      this.changed()
      return this.get(id)
    }
    if (this.count() >= MAX_TERMINAL_COMMANDS) {
      throw new Rejection('terminal_commands_full', `最多保存 ${MAX_TERMINAL_COMMANDS} 条常用命令`)
    }
    const created = randomUUID()
    this.db
      .prepare('INSERT INTO terminal_commands (id, label, command, run, project_path, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(created, label, command, run ? 1 : 0, projectPath, this.now())
    this.changed()
    return this.get(created)
  }

  // Deleting one that is already gone is not an error: another window got there first.
  delete(id: string): void {
    if (this.db.prepare('DELETE FROM terminal_commands WHERE id = ?').run(id).changes > 0) this.changed()
  }

  private get(id: string): TerminalCommand {
    const command = this.list().find((each) => each.id === id)
    if (!command) throw new Rejection('terminal_command_not_found', '这条常用命令已经被删除了')
    return command
  }

  private count(): number {
    return z.object({ count: z.number() }).parse(this.db.prepare('SELECT count(*) AS count FROM terminal_commands').get()).count
  }

  private changed(): void {
    this.emit(this.list())
  }
}
