import { describe, expect, it } from 'vitest'
import { commandOf } from './agent-commands'
import { codexCommand, requestText } from './codex-commands'

const skills = [{ name: 'simplify', description: '', path: '/s/SKILL.md' }]

describe('commandOf', () => {
  it('reads the command a message starts with, and what follows it', () => {
    expect(commandOf('/review main')).toEqual({ name: 'review', args: 'main' })
    expect(commandOf('  /compact  ')).toEqual({ name: 'compact', args: '' })
    expect(commandOf('/simplify a\nb')).toEqual({ name: 'simplify', args: 'a\nb' })
  })

  it('takes a path or a bare slash for what it is, not a command', () => {
    expect(commandOf('/')).toBeNull()
    expect(commandOf('//comment')).toBeNull()
    expect(commandOf('see /review')).toBeNull()
  })
})

describe('codexCommand', () => {
  it('knows its commands only by their exact name', () => {
    expect(codexCommand('/compact', skills)).toEqual({ kind: 'compact' })
    expect(codexCommand('/Compact', skills)).toBeNull()
    expect(codexCommand('/compact now please', skills)).toBeNull()
    expect(codexCommand('/review', skills)).toEqual({ kind: 'review', branch: null })
    expect(codexCommand('/simplify x', skills)).toMatchObject({ kind: 'skill', skill: { name: 'simplify' } })
    expect(codexCommand('/other', skills)).toBeNull()
  })

  it('shows a request as the command it stands for', () => {
    expect(requestText('thread/compact/start', {})).toBe('/compact')
    expect(requestText('review/start', { target: { type: 'baseBranch', branch: 'main' } })).toBe('/review main')
    expect(requestText('review/start', { target: { type: 'uncommittedChanges' } })).toBe('/review')
    expect(requestText('turn/start', {})).toBeNull()
  })
})
