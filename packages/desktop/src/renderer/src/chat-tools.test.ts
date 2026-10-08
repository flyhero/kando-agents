import { describe, expect, it } from 'vitest'
import { diffCounts, runHeadline, runSummary, subagentBrief, workedFor, formatTokens, elapsedText, thoughtFor, commandKeyword, toolLabel, toolIconKind, toolInputLanguage, toolDisplayStatus, commandExitCode, toolRunStatus } from './chat-tools'
import type { ChatItem } from '@kando/protocol'

type ToolExecution = Pick<Extract<ChatItem, { kind: 'tool' }>, 'name' | 'status' | 'execution'>

describe('command execution presentation', () => {
  const nonzero: ToolExecution = { name: 'commandExecution', status: 'failed', execution: { status: 'completed', exitCode: 1 } }

  it.each(['Bash', 'commandExecution'])('presents a completed %s call without erasing its exit result', (name) => {
    expect(toolDisplayStatus({ ...nonzero, name })).toBe('done')
    expect(commandExitCode({ ...nonzero, name })).toBe(1)
  })

  it('keeps unknown failures and non-command failures visible', () => {
    expect(toolDisplayStatus({ name: 'Bash', status: 'failed' })).toBe('failed')
    expect(toolDisplayStatus({ ...nonzero, name: 'Read' })).toBe('failed')
    expect(commandExitCode({ ...nonzero, name: 'Read' })).toBeNull()
    expect(toolDisplayStatus({ ...nonzero, execution: { status: 'failed', exitCode: 1 } })).toBe('failed')
    expect(commandExitCode({ name: 'Bash', status: 'done', execution: { status: 'completed', exitCode: null } })).toBeNull()
  })

  it.each(['running', 'denied', 'interrupted'] as const)('keeps %s ahead of execution metadata', (status) => {
    expect(toolDisplayStatus({ ...nonzero, status })).toBe(status)
  })

  it.each([[19, 1], [21, 3]])('does not count %i commands with %i nonzero exits as group exceptions', (count, nonzeroCount) => {
    const tools: ToolExecution[] = Array.from({ length: count }, (_, index) => index < nonzeroCount
      ? nonzero : { name: 'Bash', status: 'done' })
    expect(toolRunStatus(tools)).toEqual({ status: 'done', failed: 0, denied: 0, interrupted: 0 })
  })

  it('keeps exceptions, refusals and interruptions distinct while another call runs', () => {
    expect(toolRunStatus([
      nonzero, { name: 'Bash', status: 'running' }, { name: 'Bash', status: 'failed' },
      { name: 'Read', status: 'failed' }, { name: 'Bash', status: 'denied' }, { name: 'Bash', status: 'interrupted' }
    ])).toEqual({ status: 'running', failed: 2, denied: 1, interrupted: 1 })
  })
})

describe('toolIconKind', () => {
  it('recognizes both agents and Kando MCP aliases', () => {
    expect(['Write', 'MultiEdit', 'fileChange'].map(toolIconKind)).toEqual(['edit', 'edit', 'edit'])
    expect(['Bash', 'commandExecution', 'mcp__kando__terminal_run', 'kando.terminal_read'].map(toolIconKind)).toEqual(['terminal', 'terminal', 'terminal', 'terminal'])
    expect(['Read', 'Grep', 'Glob', 'webSearch'].map(toolIconKind)).toEqual(['read', 'search', 'search', 'search'])
    expect(['WebFetch', 'mcp__kando__browser_navigate', 'kando.browser_click'].map(toolIconKind)).toEqual(['browser', 'browser', 'browser'])
    expect(['imageView', 'mcp__kando__browser_screenshot', 'kando.show_preview'].map(toolIconKind)).toEqual(['image', 'image', 'image'])
  })

  it('keeps unfamiliar third-party tools recognizable as tools', () => {
    expect(toolIconKind('mcp__github__create_pull_request')).toBe('tool')
  })
})

describe('toolInputLanguage', () => {
  it('reads a command as shell, a plan as markdown and other arguments as JSON', () => {
    expect(toolInputLanguage('Bash', 'git status')).toBe('bash')
    expect(toolInputLanguage('commandExecution', 'ls -la')).toBe('bash')
    expect(toolInputLanguage('ExitPlanMode', '# Plan')).toBe('markdown')
    expect(toolInputLanguage('mcp__kando__terminal_run', '{\n  "command": "pnpm dev"\n}')).toBe('json')
  })

  it('leaves input that is neither plain', () => {
    expect(toolInputLanguage('mcp__github__search', 'free text')).toBeNull()
  })
})

describe('runSummary', () => {
  it('counts a run of calls by kind, in the order each first came up', () => {
    const names = ['Read', 'Grep', 'Read', 'Bash', 'Glob', 'mcp__kando__read_task_details']
    expect(runSummary(names.map((name) => ({ name })))).toBe('读取 2 个文件，搜索 2 次，运行 1 个命令，mcp__kando__read_task_details 1 次')
  })

  it('counts the browser tools together, by either agent\'s name for them', () => {
    expect(runSummary(['mcp__kando__browser_click', 'kando.browser_type', 'Read'].map((name) => ({ name })))).toBe('浏览器操作 2 次，读取 1 个文件')
    expect(toolLabel('mcp__kando__browser_screenshot')).toBe('截图')
    expect(toolLabel('browser_host')).toBe('打开网站')
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
    expect(commandKeyword(`node --input-type=module -e 'import { chromium } from "@playwright/test"'`)).toBe('node')
    expect(commandKeyword(`python3 -c "print(1)"`)).toBe('python3')
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
