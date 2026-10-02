import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TERMINAL_COMMANDS, type TerminalCommand } from '@kando/protocol'
import { TaskStore } from './task-store'
import { TerminalCommandStore } from './terminal-commands'

describe('TerminalCommandStore', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let emitted: TerminalCommand[][]
  let clock: number
  let store: TerminalCommandStore

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-terminal-commands-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    emitted = []
    clock = 1000
    store = new TerminalCommandStore(database, (list) => emitted.push(list), () => clock++)
  })

  afterEach(() => {
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('adds commands oldest first and tells every client', () => {
    const dev = store.save({ label: '启动 core', command: 'pnpm dev:core', run: true, projectPath: '/repo' })
    store.save({ label: '', command: 'git status', run: false, projectPath: null })

    expect(dev).toMatchObject({ label: '启动 core', command: 'pnpm dev:core', run: true, projectPath: '/repo', createdAt: 1000 })
    expect(store.list().map((each) => [each.command, each.run])).toEqual([['pnpm dev:core', true], ['git status', false]])
    expect(emitted).toHaveLength(2)
    expect(emitted.at(-1)).toEqual(store.list())
  })

  it('edits one in place, keeping its id and place in the list', () => {
    const first = store.save({ label: 'a', command: 'echo a', run: true, projectPath: null })
    store.save({ label: 'b', command: 'echo b', run: true, projectPath: null })

    const edited = store.save({ id: first.id, label: 'a2', command: 'echo a2', run: false, projectPath: '/repo' })

    expect(edited).toEqual({ ...first, label: 'a2', command: 'echo a2', run: false, projectPath: '/repo' })
    expect(store.list().map((each) => each.label)).toEqual(['a2', 'b'])
  })

  it('refuses to edit one that is gone instead of bringing it back', () => {
    const command = store.save({ label: '', command: 'ls', run: true, projectPath: null })
    store.delete(command.id)

    expect(() => store.save({ ...command, command: 'ls -la' })).toThrow(expect.objectContaining({ reason: 'terminal_command_not_found' }))
    expect(store.list()).toEqual([])
  })

  it('deletes quietly when the command is already gone', () => {
    const command = store.save({ label: '', command: 'ls', run: true, projectPath: null })
    store.delete(command.id)
    store.delete(command.id)

    expect(emitted).toHaveLength(2)
  })

  it('keeps commands across a restart', () => {
    store.save({ label: '', command: 'make test', run: true, projectPath: null })
    store.close()
    store = new TerminalCommandStore(database, () => {})

    expect(store.list().map((each) => each.command)).toEqual(['make test'])
  })

  it('stops adding at the limit but still allows edits', () => {
    for (let index = 0; index < MAX_TERMINAL_COMMANDS; index++) store.save({ label: '', command: `echo ${index}`, run: true, projectPath: null })
    const [first] = store.list()

    expect(() => store.save({ label: '', command: 'one more', run: true, projectPath: null })).toThrow(
      expect.objectContaining({ reason: 'terminal_commands_full' })
    )
    expect(first && store.save({ ...first, label: 'still editable' }).label).toBe('still editable')
  })
})
