import { describe, expect, it } from 'vitest'
import type { SavedChatCommand } from '@kando/protocol'
import { agentEntries, commandQuery, expandPrompt, kandoEntries, matchCommands, typedKandoCommand } from './chat-commands'

const saved = (name: string, prompt: string, projectPath: string | null = null): SavedChatCommand => ({
  id: `00000000-0000-4000-8000-${name.padStart(12, '0').slice(-12)}`,
  name,
  description: '',
  prompt,
  projectPath,
  createdAt: 1
})

describe('commandQuery', () => {
  it('reads the name being typed while the input holds nothing else', () => {
    expect(commandQuery('/')).toBe('')
    expect(commandQuery('/rev')).toBe('rev')
    expect(commandQuery('/review main')).toBeNull()
    expect(commandQuery('hi /rev')).toBeNull()
    expect(commandQuery('')).toBeNull()
  })
})

describe('matchCommands', () => {
  const entries = [
    ...kandoEntries([saved('fix-test', 'Fix $ARGUMENTS')], []),
    ...agentEntries([
      { name: 'compact', description: 'Free up context', argumentHint: null },
      { name: 'code-review', description: 'Review the diff', argumentHint: null },
      { name: 'init', description: 'Write CLAUDE.md for the codebase', argumentHint: null }
    ])
  ]

  it('puts names that start with the query ahead of names and descriptions that have it', () => {
    expect(matchCommands(entries, 'co').map((entry) => entry.name)).toEqual(['compact', 'code-review', 'init'])
    expect(matchCommands(entries, 'review').map((entry) => entry.name)).toEqual(['code-review'])
  })

  it('offers everything for a bare slash, in each source\'s order', () => {
    expect(matchCommands(entries, '').map((entry) => entry.name)).toEqual(['fix-test', 'compact', 'code-review', 'init'])
  })
})

describe('kandoEntries', () => {
  it('offers a project\'s commands only in conversations on it', () => {
    const commands = [saved('all', 'x'), saved('repo', 'y', '/work/repo'), saved('other', 'z', '/work/other')]
    expect(kandoEntries(commands, ['/work/repo']).map((entry) => entry.name)).toEqual(['all', 'repo'])
    expect(kandoEntries(commands, []).map((entry) => entry.name)).toEqual(['all'])
  })

  it('says a command takes arguments when its prompt has a place for them', () => {
    const [withArgs, without] = kandoEntries([saved('a', 'Fix $ARGUMENTS'), saved('b', 'Explain\nthe code')], [])
    expect(withArgs?.argumentHint).toBe('参数')
    expect(without).toMatchObject({ argumentHint: null, description: 'Explain' })
  })
})

describe('expandPrompt', () => {
  it('puts what was typed in each place the prompt leaves for it', () => {
    expect(expandPrompt('Fix $ARGUMENTS, then test $ARGUMENTS', ' login ')).toBe('Fix login, then test login')
    expect(expandPrompt('Fix $ARGUMENTS', '')).toBe('Fix')
  })

  it('adds what was typed after a prompt that leaves no place for it', () => {
    expect(expandPrompt('Explain the code', 'in auth.ts')).toBe('Explain the code\n\nin auth.ts')
    expect(expandPrompt('Explain the code', '')).toBe('Explain the code')
  })
})

describe('typedKandoCommand', () => {
  const entries = [...kandoEntries([saved('fix', 'Fix $ARGUMENTS')], []), ...agentEntries([{ name: 'compact', description: '', argumentHint: null }])]

  it('finds the user\'s own command a message names, whatever its case', () => {
    expect(typedKandoCommand('/Fix the login\ntest', entries)).toMatchObject({ command: { name: 'fix' }, args: 'the login\ntest' })
    expect(typedKandoCommand('/fix', entries)).toMatchObject({ args: '' })
  })

  it('leaves the agent\'s commands and plain messages alone', () => {
    expect(typedKandoCommand('/compact', entries)).toBeNull()
    expect(typedKandoCommand('please /fix', entries)).toBeNull()
  })
})
