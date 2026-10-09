import type { GitCommit } from '@kando/protocol'

export type GraphRow = { lane: number; width: number; paths: string[] }

// Pending parents keep their lanes across pages, including parents not loaded yet.
export function gitGraph(commits: readonly GitCommit[]): GraphRow[] {
  let lanes: string[] = []
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) { lane = lanes.length; lanes.push(commit.sha) }
    const before = [...lanes]
    const after = [...lanes]
    after.splice(lane, 1, ...(commit.parents[0] && !after.includes(commit.parents[0]) ? [commit.parents[0]] : []))
    for (const parent of commit.parents.slice(1)) if (!after.includes(parent)) after.push(parent)
    const x = (index: number) => 8 + index * 12
    const paths = before.flatMap((sha, index) => sha === commit.sha
      ? [`M${x(index)} 0V16`, ...commit.parents.map((parent) => `M${x(index)} 16L${x(after.indexOf(parent))} 32`)]
      : [`M${x(index)} 0L${x(after.indexOf(sha))} 32`])
    lanes = after
    return { lane, width: Math.max(before.length, after.length) * 12 + 4, paths }
  })
}
