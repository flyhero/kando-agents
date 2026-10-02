import { describe, expect, it } from 'vitest'
import type { TerminalCommand } from '@kando/protocol'
import { isInside, offeredCommands, pastedCommand, terminalProject } from './terminal-commands'

let next = 0
function command(fields: Partial<TerminalCommand>): TerminalCommand {
  next++
  return { id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`, label: '', command: 'true', run: true, projectPath: null, createdAt: next, ...fields }
}

describe('isInside', () => {
  it('takes the folder itself and what is under it, not a sibling that shares a prefix', () => {
    expect(isInside('/repo', '/repo')).toBe(true)
    expect(isInside('/repo/packages/core', '/repo/')).toBe(true)
    expect(isInside('C:\\repo\\src', 'C:\\repo')).toBe(true)
    expect(isInside('/repo-old', '/repo')).toBe(false)
  })
})

describe('terminalProject', () => {
  const tasks = [{ repos: [{ path: '/code/app', worktreePath: '/home/.kando/worktrees/1/app', branch: null, startRef: null, start: null }] }]

  it('reads a task worktree as the project it came from', () => {
    expect(terminalProject('/home/.kando/worktrees/1/app/src', tasks)).toBe('/code/app')
  })

  it('takes any other folder as it is', () => {
    expect(terminalProject('/code/other', tasks)).toBe('/code/other')
  })
})

describe('offeredCommands', () => {
  const dev = command({ label: '启动 core', command: 'pnpm dev:core', projectPath: '/code/app' })
  const elsewhere = command({ label: 'deploy', command: 'make deploy', projectPath: '/code/other' })
  const status = command({ command: 'git status' })
  const log = command({ label: '最近提交', command: 'git log --oneline -20' })

  it('offers a project its own commands and the global ones, not another project\'s', () => {
    expect(offeredCommands([dev, elsewhere, status, log], '/code/app/packages', '')).toEqual({ project: [dev], global: [status, log] })
  })

  it('puts commands the query names ahead of those it is only in the command of', () => {
    const named = command({ label: 'git 图', command: 'tig' })
    expect(offeredCommands([dev, status, log, named], '/code/app', 'GIT').global).toEqual([named, status, log])
    expect(offeredCommands([dev, status, log], '/code/app', 'core').project).toEqual([dev])
    expect(offeredCommands([dev, status, log], '/code/app', 'nothing')).toEqual({ project: [], global: [] })
  })
})

describe('pastedCommand', () => {
  it('keeps the lines when the shell takes bracketed paste, else joins them into one list', () => {
    expect(pastedCommand('cd web\nnpm test', true)).toBe('cd web\nnpm test')
    expect(pastedCommand('cd web\r\n\n  npm test  ', false)).toBe('cd web; npm test')
  })
})
