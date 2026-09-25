import { describe, expect, it } from 'vitest'
import { checkDependencies, createsCycle } from './dependencies'

// a → b → c: a depends on b, b depends on c.
const graph: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] }
const lookup = (id: string) => graph[id] ?? []

describe('createsCycle', () => {
  it('rejects depending on yourself', () => {
    expect(createsCycle(lookup, 'a', 'a')).toBe(true)
  })

  it('rejects closing a loop through other tasks', () => {
    expect(createsCycle(lookup, 'c', 'a')).toBe(true)
    expect(createsCycle(lookup, 'b', 'a')).toBe(true)
  })

  it('allows new edges that keep the graph acyclic', () => {
    expect(createsCycle(lookup, 'a', 'c')).toBe(false)
    expect(createsCycle(lookup, 'd', 'a')).toBe(false)
  })
})

describe('checkDependencies', () => {
  it('flags the whole list when any entry would loop', () => {
    expect(checkDependencies(lookup, 'c', ['d', 'a'])).toBe('dependency-cycle')
    expect(checkDependencies(lookup, 'c', ['d'])).toBeNull()
  })
})
