import type { GitCommit } from '@kando/protocol'

// How many colours the lines cycle through (--graph-1 … in styles.css).
export const GRAPH_COLORS = 6

export type GraphPath = { d: string; color: number }
export type GraphRow = { lane: number; color: number; width: number; paths: GraphPath[] }

// Pending parents keep their lanes across pages, including parents not loaded yet. A branch keeps
// one colour down its first parents, as IDEA's log does: a lane takes the colour of the tip that
// opened it, a merge's other parent opens one in the next colour, and a line keeps its own colour
// into the lane it joins.
export function gitGraph(commits: readonly GitCommit[]): GraphRow[] {
  let lanes: { sha: string; color: number }[] = []
  let opened = 0
  const open = (sha: string) => ({ sha, color: opened++ % GRAPH_COLORS })
  return commits.map((commit) => {
    let lane = lanes.findIndex((entry) => entry.sha === commit.sha)
    if (lane < 0) { lane = lanes.length; lanes.push(open(commit.sha)) }
    const color = lanes[lane]?.color ?? 0
    const before = [...lanes]
    const after = [...lanes]
    const at = (sha: string) => after.findIndex((entry) => entry.sha === sha)
    const first = commit.parents[0]
    const waiting = first ? at(first) : -1
    after.splice(lane, 1, ...(first && (waiting < 0 || waiting > lane) ? [{ sha: first, color }] : []))
    // A parent a branch to the right reached first moves left into this lane, as the trunk's: its
    // line, and colour, would otherwise turn at the fork. The branch's lane joins it here.
    if (waiting > lane) after.splice(waiting, 1)
    for (const parent of commit.parents.slice(1)) if (at(parent) < 0) after.push(open(parent))
    const x = (index: number) => 8 + index * 12
    const paths = before.flatMap((entry, index) => entry.sha === commit.sha
      ? [{ d: `M${x(index)} 0V16`, color }, ...commit.parents.map((parent, i) => ({ d: `M${x(index)} 16L${x(at(parent))} 32`, color: i === 0 ? color : after[at(parent)]?.color ?? color }))]
      : [{ d: `M${x(index)} 0L${x(at(entry.sha))} 32`, color: entry.color }])
    lanes = after
    return { lane, color, width: Math.max(before.length, after.length) * 12 + 4, paths }
  })
}
