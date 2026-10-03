import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_CHAT_COMMANDS, type SavedChatCommand } from '@kando/protocol'
import { ChatCommandStore } from './chat-commands'
import { TaskStore } from './task-store'

describe('ChatCommandStore', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let emitted: SavedChatCommand[][]
  let clock: number
  let store: ChatCommandStore
  const command = (name: string, projectPath: string | null = null) => ({ name, description: '', prompt: `Do ${name} with $ARGUMENTS`, projectPath })

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-commands-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    emitted = []
    clock = 1000
    store = new ChatCommandStore(database, (list) => emitted.push(list), () => clock++)
  })

  afterEach(() => {
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('adds commands oldest first and tells every client', () => {
    const fix = store.save({ ...command('fix', '/repo'), description: 'Fix the failing test' })
    store.save(command('explain'))

    expect(fix).toMatchObject({ name: 'fix', description: 'Fix the failing test', prompt: 'Do fix with $ARGUMENTS', projectPath: '/repo', createdAt: 1000 })
    expect(store.list().map((each) => each.name)).toEqual(['fix', 'explain'])
    expect(emitted).toHaveLength(2)
    expect(emitted.at(-1)).toEqual(store.list())
  })

  it('edits one in place, keeping its id and place in the list', () => {
    const first = store.save(command('a'))
    store.save(command('b'))

    const edited = store.save({ id: first.id, ...command('a2', '/repo') })

    expect(edited).toEqual({ ...first, ...command('a2', '/repo') })
    expect(store.list().map((each) => each.name)).toEqual(['a2', 'b'])
  })

  it('takes a name once across all projects and once in each, whatever its case', () => {
    const fix = store.save(command('fix'))
    store.save(command('fix', '/repo'))

    expect(() => store.save(command('FIX'))).toThrow(expect.objectContaining({ reason: 'chat_command_taken' }))
    expect(() => store.save(command('fix', '/repo'))).toThrow(expect.objectContaining({ reason: 'chat_command_taken' }))
    expect(store.save({ ...fix, prompt: 'Fix it' }).prompt).toBe('Fix it')
  })

  it('refuses to edit one that is gone instead of bringing it back', () => {
    const saved = store.save(command('gone'))
    store.delete(saved.id)
    store.delete(saved.id)

    expect(() => store.save({ ...saved, prompt: 'again' })).toThrow(expect.objectContaining({ reason: 'chat_command_not_found' }))
    expect(store.list()).toEqual([])
    expect(emitted).toHaveLength(2)
  })

  it('keeps commands across a restart', () => {
    store.save(command('kept'))
    store.close()
    store = new ChatCommandStore(database, () => {})

    expect(store.list().map((each) => each.name)).toEqual(['kept'])
  })

  it('stops adding at the limit but still allows edits', () => {
    for (let index = 0; index < MAX_CHAT_COMMANDS; index++) store.save(command(`c${index}`))
    const [first] = store.list()

    expect(() => store.save(command('more'))).toThrow(expect.objectContaining({ reason: 'chat_commands_full' }))
    expect(first && store.save({ ...first, description: 'still editable' }).description).toBe('still editable')
  })
})
