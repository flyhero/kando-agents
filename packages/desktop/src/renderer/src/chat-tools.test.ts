import { describe, expect, it } from 'vitest'
import { diffCounts, runHeadline, runSummary, subagentBrief, workedFor, formatTokens, elapsedText, thoughtFor, commandKeyword } from './chat-tools'

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

describe('runHeadline', () => {
  const call = (status: 'running' | 'done', description: string | null = null) => ({ name: 'Bash', status, description })

  it('reads as the call under way while it says what it does, and as the count once done', () => {
    expect(runHeadline([call('done', 'List files'), call('running', 'Read the config')])).toEqual({ text: 'Read the config', described: true })
    expect(runHeadline([call('done', 'List files'), call('done', 'Read the config')])).toEqual({ text: '运行 2 个命令', described: false })
    expect(runHeadline([call('done'), call('running')])).toEqual({ text: '运行 2 个命令', described: false })
  })
})

describe('commandKeyword', () => {
  it('names the program, past cd, env and launchers', () => {
    expect(commandKeyword('cd /Users/me/repo && git branch --show-current && grep -rn foo . | head -40')).toBe('git')
    expect(commandKeyword('set -a && source .env && FOO=1 npx tsx scripts/report/monthly.ts')).toBe('monthly.ts')
    expect(commandKeyword('pnpm vitest run orders --reporter=dot')).toBe('vitest')
    expect(commandKeyword('sudo -n true')).toBe('true')
  })
})

describe('thoughtFor', () => {
  it('keeps tenths under a minute, where most thoughts end', () => {
    expect([40, 2640, 12_400, 75_000].map(thoughtFor)).toEqual(['0.1 秒', '2.6 秒', '12.4 秒', '1 分 15 秒'])
  })
})

describe('elapsedText', () => {
  it('counts tenths under a minute, minutes after', () => {
    expect([400, 12_340, 61_000].map(elapsedText)).toEqual(['0.4s', '12.3s', '1 分 1 秒'])
  })
})

describe('formatTokens', () => {
  it('reads at a glance at every size', () => {
    expect([842, 2340, 42_100, 1_200_000].map(formatTokens)).toEqual(['842', '2.3k', '42k', '1.2M'])
  })
})
