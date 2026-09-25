import { describe, expect, it } from 'vitest'
import { searchSnippet } from './conversation-search'

describe('searchSnippet', () => {
  it('keeps short text whole, on one line', () => {
    expect(searchSnippet('  Fix the\n\nlogin   bug ', 'login')).toBe('Fix the login bug')
  })

  it('trims long text to the context around the match', () => {
    const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`
    expect(searchSnippet(text, 'needle')).toBe(`…${'a'.repeat(20)}NEEDLE${'b'.repeat(60)}…`)
  })

  it('still finds a query with runs of spaces once both are flattened', () => {
    expect(searchSnippet(`${'x'.repeat(50)} two  words`, 'two  words')).toBe(`…${'x'.repeat(19)} two words`)
  })
})
