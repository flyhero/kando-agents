import { describe, expect, it } from 'vitest'
import { diffCounts, runSummary, subagentBrief, workedFor } from './chat-tools'

describe('runSummary', () => {
  it('counts a run of calls by kind, in the order each first came up', () => {
    const names = ['Read', 'Grep', 'Read', 'Bash', 'Glob', 'mcp__kando__read_task_details']
    expect(runSummary(names.map((name) => ({ name })))).toBe('读取 2 个文件，搜索 2 次，运行 1 个命令，mcp__kando__read_task_details 1 次')
  })
})

describe('diffCounts', () => {
  it('counts added and removed lines, not the file headers', () => {
    expect(diffCounts([{ patch: '--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more' }, { patch: '' }])).toEqual({ added: 2, removed: 1 })
  })
})

describe('workedFor', () => {
  it('says a turn\'s length in seconds, minutes or hours', () => {
    expect(workedFor(5_900)).toBe('6 秒')
    expect(workedFor(70_800)).toBe('1 分 11 秒')
    expect(workedFor(120_000)).toBe('2 分钟')
    expect(workedFor(3_900_000)).toBe('1 小时 5 分')
  })
})

describe('subagentBrief', () => {
  it('reads what a subagent was told and its kind, or keeps an input cut short as it is', () => {
    expect(subagentBrief(JSON.stringify({ description: 'Find', prompt: 'Look for x', subagent_type: 'Explore' }))).toEqual({ kind: 'Explore', prompt: 'Look for x' })
    expect(subagentBrief('{"prompt": "cut sho')).toEqual({ kind: null, prompt: '{"prompt": "cut sho' })
    expect(subagentBrief(null)).toEqual({ kind: null, prompt: null })
  })
})
