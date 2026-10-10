import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@kando/protocol'
import { GRAPH_COLORS, gitGraph } from './git-graph'
const commit = (sha: string, parents: string[]): GitCommit => ({ sha, parents, subject: sha, author: 'test', date: '', refs: [] })
describe('commit graph', () => {
  it('keeps diverging lanes through a merge and joins them at their common ancestor', () => {
    const rows = gitGraph([commit('merge', ['left', 'right']), commit('left', ['base']), commit('right', ['base']), commit('base', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(rows[0]?.paths).toHaveLength(3)
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
    expect(rows[0]?.paths.map((path) => path.color)).toEqual([0, 0, 1])
    expect(rows[1]?.paths.find((path) => path.d.startsWith('M20 16'))?.color).toBe(1)
    // The trunk passing the feature's row stays the trunk's colour.
    expect(rows[1]?.paths.find((path) => path.d.startsWith('M8 0'))?.color).toBe(0)
  })
  it('gives each new tip the next colour and starts over after the last', () => {
    const tips = Array.from({ length: GRAPH_COLORS + 1 }, (_, i) => commit(`tip${i}`, []))
    expect(gitGraph(tips).map((row) => row.color)).toEqual([0, 1, 2, 3, 4, 5, 0])
  })
})
