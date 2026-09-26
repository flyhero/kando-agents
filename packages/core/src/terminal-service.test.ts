import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Terminal } from '@kando/protocol'
import type { DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { TaskStore } from './task-store'
import { TerminalService, userShell } from './terminal-service'

type Handlers = { [M in DaemonMethod]: (params: DaemonParams<M>) => DaemonResult<M> }

function fakeDaemon(): SessionHost & { spawns: DaemonParams<'spawn'>[]; killed: string[] } {
  const spawns: DaemonParams<'spawn'>[] = []
  const killed: string[] = []
  const handlers: Handlers = {
    spawn: (params) => {
      spawns.push(params)
      return { sessionId: `session-${spawns.length}` }
    },
    write: () => ({ ok: true }),
    resize: () => ({ ok: true }),
    kill: ({ sessionId }) => {
      killed.push(sessionId)
      return { ok: true }
    },
    attach: ({ sessionId }) => ({ sessionId, buffer: '', bufferStart: 0, endOffset: 0, exited: false, exitCode: null }),
    list: () => ({ sessions: [] })
  }
  return { spawns, killed, request: async (method, params) => handlers[method](params), onEvent: () => () => {} }
}

describe('TerminalService', () => {
  let root: string
  let database: string
  let tasks: TaskStore
  let daemon: ReturnType<typeof fakeDaemon>
  let emitted: Terminal[][]
  let service: TerminalService

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-terminals-'))
    database = path.join(root, 'kando.db')
    tasks = new TaskStore(database)
    daemon = fakeDaemon()
    emitted = []
    service = new TerminalService(database, daemon, (list) => emitted.push(list))
  })

  afterEach(() => {
    service.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('opens the user\'s shell in the folder asked for, or home when that is not a folder', async () => {
    const opened = await service.open(root)
    expect(opened).toMatchObject({ cwd: root, title: path.basename(root), sessionId: 'session-1' })
    expect(daemon.spawns[0]).toMatchObject({ ...userShell(), cwd: root })
    expect((await service.open(path.join(root, 'missing'))).cwd).toBe(os.homedir())
    expect((await service.open('relative/dir')).cwd).toBe(os.homedir())
    expect(emitted.at(-1)).toHaveLength(3)
  })

  it('keeps its terminals across a core restart', async () => {
    await service.open(root)
    const restarted = new TerminalService(database, daemon, () => {})
    expect(restarted.list()).toHaveLength(1)
    restarted.close()
  })

  it('drops a terminal when it is closed, when its shell exits, or when the daemon lost it', async () => {
    const first = await service.open(root)
    const second = await service.open(root)
    const third = await service.open(root)
    await service.kill(first.id)
    expect(daemon.killed).toEqual([first.sessionId])
    service.handleExit(second.sessionId)
    expect(service.list().map((terminal) => terminal.id)).toEqual([third.id])
    service.reconcile([{ sessionId: third.sessionId, exited: true, exitCode: 0 }])
    expect(service.list()).toEqual([])
    expect(emitted.at(-1)).toEqual([])
  })

  it('starts a login shell, falling back to sh', () => {
    if (process.platform === 'win32') return
    expect(userShell({ SHELL: '/bin/zsh' })).toEqual({ command: '/bin/zsh', args: ['-l'] })
    expect(userShell({})).toEqual({ command: '/bin/sh', args: ['-l'] })
  })
})
