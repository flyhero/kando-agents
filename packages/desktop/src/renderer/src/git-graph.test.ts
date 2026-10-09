import { describe, expect, it } from 'vitest'
import type { GitCommit } from '@kando/protocol'
import { gitGraph } from './git-graph'
const commit = (sha: string, parents: string[]): GitCommit => ({ sha, parents, subject: sha, author: 'test', date: '', refs: [] })
describe('commit graph', () => {
  it('keeps diverging lanes through a merge and joins them at their common ancestor', () => {
    const rows = gitGraph([commit('merge', ['left', 'right']), commit('left', ['base']), commit('right', ['base']), commit('base', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(rows[0]?.paths).toHaveLength(3)
    expect(rows[2]?.paths.some((path) => path.includes('L8 32'))).toBe(true)
    expect(rows.flatMap((row) => row.paths).join('')).not.toContain('L-')
  })
  it('keeps unseen parent lanes when another page is appended', () => {
    const commits = [commit('a', ['b']), commit('other', ['c'])]
    expect(gitGraph([...commits, commit('b', ['c'])]).slice(0, 2)).toEqual(gitGraph(commits))
  })
})
