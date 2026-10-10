import type { GitCommit } from '@kando/protocol'

// How many colours the lines cycle through (--graph-1 … in styles.css).
export const GRAPH_COLORS = 6
// An edge that would run past this many rows is drawn as arrows at its two ends instead, as IDEA's
// log does: kept whole, branches merged long after they forked fill the panel with idle lanes.
export const LONG_EDGE_ROWS = 20

export type GraphPath = { d: string; color: number }
export type GraphRow = { lane: number; color: number; width: number; paths: GraphPath[] }

const x = (lane: number) => 8 + lane * 12
// A chevron pointing down with its tip at (cx, tip).
const arrow = (cx: number, tip: number) => `M${cx - 3} ${tip - 3}L${cx} ${tip}L${cx + 3} ${tip - 3}`

// Pending parents keep their lanes across pages, including parents not loaded yet. A branch keeps
// one colour down its first parents, as IDEA's log does: a lane takes the colour of the tip that
// opened it, a merge's other parent opens one in the next colour, and a line keeps its own colour
// into the lane it joins.
export function gitGraph(commits: readonly GitCommit[]): GraphRow[] {
  const rowOf = new Map(commits.map((commit, index) => [commit.sha, index]))
  // A parent not loaded yet counts as far once this many rows below have not held it, so appending
  // a page never redraws an edge already decided.
  const far = (from: number, sha: string) => {
    const to = rowOf.get(sha)
    return to === undefined ? commits.length - 1 - from >= LONG_EDGE_ROWS : to - from > LONG_EDGE_ROWS
  }
  let lanes: { sha: string; color: number }[] = []
  // Parents some edge reaches only by arrow, with the colour that edge was.
  const arriving = new Map<string, number>()
  let opened = 0
  const nextColor = () => opened++ % GRAPH_COLORS
  return commits.map((commit, row) => {
    let lane = lanes.findIndex((entry) => entry.sha === commit.sha)
    const awaited = lane >= 0
    const arrived = arriving.get(commit.sha)
    arriving.delete(commit.sha)
    if (!awaited) { lane = lanes.length; lanes.push({ sha: commit.sha, color: arrived ?? nextColor() }) }
    const color = lanes[lane]?.color ?? 0
    const before = [...lanes]
    const after = [...lanes]
    const at = (sha: string) => after.findIndex((entry) => entry.sha === sha)
    const stubs: GraphPath[] = []
    const first = commit.parents[0]
    const waiting = first ? at(first) : -1
    const firstFar = first !== undefined && waiting < 0 && far(row, first)
    if (first && firstFar) arriving.set(first, arriving.get(first) ?? color)
    after.splice(lane, 1, ...(first && !firstFar && (waiting < 0 || waiting > lane) ? [{ sha: first, color }] : []))
    // A parent a branch to the right reached first moves left into this lane, as the trunk's: its
    // line, and colour, would otherwise turn at the fork. The branch's lane joins it here.
    if (!firstFar && waiting > lane) after.splice(waiting, 1)
    if (firstFar) stubs.push({ d: `M${x(lane)} 16V29${arrow(x(lane), 29)}`, color })
    for (const parent of commit.parents.slice(1)) {
      if (at(parent) >= 0) continue
      if (far(row, parent)) {
        const parentColor = arriving.get(parent) ?? nextColor()
        arriving.set(parent, parentColor)
        stubs.push({ d: `M${x(lane)} 16L${x(lane) + 8} 28${arrow(x(lane) + 8, 28)}`, color: parentColor })
      } else after.push({ sha: parent, color: nextColor() })
    }
    const paths = before.flatMap((entry, index) => entry.sha === commit.sha
      ? [
          // A tip has nothing above it; a parent reached by arrow shows the arrow coming in.
          ...(awaited ? [{ d: `M${x(index)} 0V16`, color }] : []),
          ...(arrived !== undefined && !awaited ? [{ d: `M${x(index)} 2V13${arrow(x(index), 13)}`, color }] : []),
          ...commit.parents.flatMap((parent, i) => at(parent) < 0 || (i === 0 && firstFar) ? [] : [{ d: `M${x(index)} 16L${x(at(parent))} 32`, color: i === 0 ? color : after[at(parent)]?.color ?? color }]),
          ...stubs
        ]
      : [{ d: `M${x(index)} 0L${x(at(entry.sha))} 32`, color: entry.color }])
    lanes = after
    const reach = Math.max(before.length, after.length, lane + (stubs.length > (firstFar ? 1 : 0) ? 2 : 1))
    return { lane, color, width: reach * 12 + 4, paths }
  })
}
