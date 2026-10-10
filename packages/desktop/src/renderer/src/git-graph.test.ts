import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@kando/protocol'
import { GRAPH_COLORS, LONG_EDGE_ROWS, gitGraph } from './git-graph'
const commit = (sha: string, parents: string[]): GitCommit => ({ sha, parents, subject: sha, author: 'test', date: '', refs: [] })
describe('commit graph', () => {
  it('keeps diverging lanes through a merge and joins them at their common ancestor', () => {
    const rows = gitGraph([commit('merge', ['left', 'right']), commit('left', ['base']), commit('right', ['base']), commit('base', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    // A tip has no line above it: just its two parents.
    expect(rows[0]?.paths).toHaveLength(2)
    expect(rows[2]?.paths.some((path) => path.d.includes('L8 32'))).toBe(true)
    expect(rows.flatMap((row) => row.paths.map((path) => path.d)).join('')).not.toContain('L-')
  })
  it('keeps unseen parent lanes when another page is appended', () => {
    const commits = [commit('a', ['b']), commit('other', ['c'])]
    expect(gitGraph([...commits, commit('b', ['c'])]).slice(0, 2)).toEqual(gitGraph(commits))
  })
  it('keeps a branch in one colour down its first parents, and a merged branch in its own', () => {
    const rows = gitGraph([commit('merge', ['main', 'feature']), commit('feature', ['fork']), commit('main', ['fork']), commit('fork', [])])
    expect(rows.map((row) => row.color)).toEqual([0, 1, 0, 0])
    // The merge's line down to the feature, and the feature's line into the trunk, are the feature's colour.
    expect(rows[0]?.paths.map((path) => path.color)).toEqual([0, 1])
    expect(rows[1]?.paths.find((path) => path.d.startsWith('M20 16'))?.color).toBe(1)
    // The trunk passing the feature's row stays the trunk's colour.
    expect(rows[1]?.paths.find((path) => path.d.startsWith('M8 0'))?.color).toBe(0)
  })
  it('gives each new tip the next colour and starts over after the last', () => {
    const tips = Array.from({ length: GRAPH_COLORS + 1 }, (_, i) => commit(`tip${i}`, []))
    expect(gitGraph(tips).map((row) => row.color)).toEqual([0, 1, 2, 3, 4, 5, 0])
  })
  it('draws an edge past the long-edge limit as arrows at its ends, keeping its lane free and its colour', () => {
    const fillers = Array.from({ length: LONG_EDGE_ROWS + 2 }, (_, i) => commit(`trunk${i}`, [i === LONG_EDGE_ROWS + 1 ? 'base' : `trunk${i + 1}`]))
    const rows = gitGraph([commit('merge', ['trunk0', 'old']), ...fillers, commit('old', []), commit('base', [])])
    // The merge's other parent is far below: no lane opens for it, so the trunk stays one lane wide.
    expect(rows.slice(1, -2).every((row) => row.width === 16)).toBe(true)
    const stub = rows[0]?.paths.at(-1)
    expect(stub?.d).toMatch(/^M8 16L16 28/)
    // Where the edge arrives, an arrow comes in from above in the same colour.
    const arrival = rows.at(-2)
    expect(arrival?.color).toBe(stub?.color)
    expect(arrival?.paths.some((path) => path.d.startsWith('M20 2V13'))).toBe(true)
  })
  it('keeps a lane for a parent not loaded yet until enough rows below have passed it by', () => {
    const near = gitGraph([commit('merge', ['a', 'unloaded']), commit('a', [])])
    expect(near[1]?.width).toBe(28)
  })
})
