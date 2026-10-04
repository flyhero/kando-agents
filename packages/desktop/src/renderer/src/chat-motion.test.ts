import { describe, expect, it } from 'vitest'
import { freshKeys } from './chat-motion'

describe('freshKeys', () => {
  it('marks nothing before the history has arrived', () => {
    expect(freshKeys(null, ['a', 'b'], false).size).toBe(0)
  })

  it('marks what was not shown before', () => {
    expect([...freshKeys(new Set(['a']), ['a', 'b', 'c'], false)]).toEqual(['b', 'c'])
  })

  it('marks the first message of an empty chat', () => {
    expect([...freshKeys(new Set(), ['a'], false)]).toEqual(['a'])
  })

  it('marks nothing when older history was just loaded', () => {
    expect(freshKeys(new Set(['b']), ['a', 'b'], true).size).toBe(0)
  })
})
