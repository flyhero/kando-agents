import { BROWSER_HOST_TOOL, browserToolKind, isBrowserTool, isPreviewTool, TERMINAL_RUN_TOOL, terminalToolKind, type BrowserToolKind, type ChatDiff, type ChatItem, type TerminalToolKind } from '@kando/protocol'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Both agents' tool names, in words; an unknown one shows as the agent named it.
const TOOL_LABEL: Record<string, string> = {
  Bash: '命令',
  commandExecution: '命令',
  Read: '读取',
  imageView: '查看图片',
  Write: '写入',
  Edit: '编辑',
  MultiEdit: '编辑',
  NotebookEdit: '编辑笔记本',
  fileChange: '修改文件',
  Grep: '搜索',
  Glob: '查找文件',
  WebFetch: '读取网页',
  WebSearch: '搜索网页',
  webSearch: '搜索网页',
  Task: '子 agent',
  Agent: '子 agent',
  spawnAgent: '子 agent',
  TodoWrite: '待办',
  ExitPlanMode: '计划',
  // Kando's own question about a site its browser is to open, shown among the approvals.
  [BROWSER_HOST_TOOL]: '打开网站'
}

// Kando's browser tools, in words.
const BROWSER_LABEL: Record<BrowserToolKind, string> = {
  navigate: '打开页面',
  snapshot: '页面快照',
  screenshot: '截图',
  click: '点击',
  type: '输入',
  press: '按键',
  hover: '悬停',
  scroll: '滚动',
  select: '选择',
  wait: '等待',
  tabs: '标签页',
  console: '控制台'
}

// An agent's own terminals in the app's panel.
const TERMINAL_LABEL: Record<TerminalToolKind, string> = { run: '在终端运行', read: '读终端', stop: '停终端' }

export function toolLabel(name: string): string {
  if (isPreviewTool(name)) return '预览'
  if (name === TERMINAL_RUN_TOOL) return TERMINAL_LABEL.run
  const terminal = terminalToolKind(name)
  if (terminal) return TERMINAL_LABEL[terminal]
  const browser = browserToolKind(name)
  if (browser) return BROWSER_LABEL[browser]
  return TOOL_LABEL[name] ?? name
}

export type ToolIconKind = 'read' | 'edit' | 'terminal' | 'search' | 'browser' | 'image' | 'agent' | 'list' | 'tool'

const TOOL_ICONS: Record<string, ToolIconKind> = {
  Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', fileChange: 'edit',
  Bash: 'terminal', commandExecution: 'terminal',
  Grep: 'search', Glob: 'search', WebSearch: 'search', webSearch: 'search',
  WebFetch: 'browser', [BROWSER_HOST_TOOL]: 'browser', imageView: 'image',
  Task: 'agent', Agent: 'agent', spawnAgent: 'agent', TodoWrite: 'list', ExitPlanMode: 'list'
}

export function toolIconKind(name: string): ToolIconKind {
  if (name === TERMINAL_RUN_TOOL || terminalToolKind(name)) return 'terminal'
  if (browserToolKind(name) === 'screenshot' || isPreviewTool(name)) return 'image'
  if (isBrowserTool(name)) return 'browser'
  return TOOL_ICONS[name] ?? 'tool'
}

// What a call's input is written in, for colouring it: a shell command, a plan, or the JSON of
// any other tool's arguments; null leaves it plain.
export type ToolInputLanguage = 'bash' | 'markdown' | 'json'

export function toolInputLanguage(name: string, input: string): ToolInputLanguage | null {
  if (name === 'Bash' || name === 'commandExecution') return 'bash'
  if (name === 'ExitPlanMode') return 'markdown'
  return /^\s*[[{]/.test(input) ? 'json' : null
}

// What a run of calls did, in the words a person would use: counted by kind, in the order each kind
// first came up.
const TOOL_KIND: Record<string, { kind: string; say: (count: number) => string }> = {
  Read: { kind: 'read', say: (count) => `读取 ${count} 个文件` },
  Grep: { kind: 'search', say: (count) => `搜索 ${count} 次` },
  Glob: { kind: 'search', say: (count) => `搜索 ${count} 次` },
  WebSearch: { kind: 'search', say: (count) => `搜索 ${count} 次` },
  webSearch: { kind: 'search', say: (count) => `搜索 ${count} 次` },
  Bash: { kind: 'command', say: (count) => `运行 ${count} 个命令` },
  commandExecution: { kind: 'command', say: (count) => `运行 ${count} 个命令` },
  WebFetch: { kind: 'fetch', say: (count) => `读取 ${count} 个网页` }
}

// A burst of clicks, typing and waiting reads as one thing done in the browser.
const BROWSER_RUN = { kind: 'browser', say: (count: number) => `浏览器操作 ${count} 次` }

export function runSummary(tools: readonly Pick<ToolItem, 'name'>[]): string {
  const counts = new Map<string, { count: number; say: (count: number) => string }>()
  for (const tool of tools) {
    const known = TOOL_KIND[tool.name] ?? (isBrowserTool(tool.name) ? BROWSER_RUN : undefined)
    const kind = known?.kind ?? `tool:${tool.name}`
    const say = known?.say ?? ((count: number) => `${toolLabel(tool.name)} ${count} 次`)
    const current = counts.get(kind)
    counts.set(kind, { count: (current?.count ?? 0) + 1, say })
  }
  return [...counts.values()].map(({ count, say }) => say(count)).join('，')
}

// While a run goes it reads as the call under way, when that call says what it does in words;
// otherwise, and once it is done, as the count of what it did.
export function runHeadline(tools: readonly Pick<ToolItem, 'name' | 'status' | 'description'>[]): { text: string; described: boolean } {
  const described = tools.find((tool) => tool.status === 'running')?.description
  return described ? { text: described, described: true } : { text: runSummary(tools), described: false }
}

// A call that hands work to a subagent of its own: Claude's Task (Agent in newer versions), or a
// Codex spawn.
export function isCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'commandExecution'
}

// Shell words that never name the program being run; the ones with an argument take it along.
const SHELL_NOISE = new Set(['env', 'exec', 'nice', 'nohup', 'set', 'sudo', 'time'])
const SHELL_NOISE_WITH_ARG = new Set(['.', 'cd', 'source'])
// Launchers whose next word, or a later path, is the real subject.
const SHELL_RUNNERS = new Set(['bash', 'bun', 'bunx', 'deno', 'node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'run', 'sh', 'ts-node', 'tsx', 'uv', 'uvx', 'yarn', 'zsh'])

// The program a command runs, for a line that stands for the command: `cd repo && FOO=1 npx tsx
// scripts/report.ts | head` → `report.ts`. Env assignments, flags, noise and launchers are skipped.
export function commandKeyword(command: string): string {
  const words = command.split(/[\s;&|()]+/).filter(Boolean)
  let skip = false
  for (const word of words) {
    if (skip) {
      skip = false
      continue
    }
    if (/^[A-Z_]\w*=/i.test(word)) continue
    if (/^[+-]/.test(word)) continue
    if (SHELL_NOISE_WITH_ARG.has(word)) {
      skip = true
      continue
    }
    if (SHELL_NOISE.has(word) || SHELL_RUNNERS.has(word)) continue
    return word.includes('/') ? (word.split('/').pop() || word) : word
  }
  return words[0] ?? command
}

export function isSubagent(name: string): boolean {
  return name === 'Task' || name === 'Agent' || name === 'spawnAgent'
}

// What a subagent was told, and what kind it is, from its call's input: JSON Kando may have cut
// short, which then stays the prompt as it is.
export function subagentBrief(input: string | null): { kind: string | null; prompt: string | null } {
  if (!input) return { kind: null, prompt: null }
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === 'object') {
      const kind = 'subagent_type' in parsed && typeof parsed.subagent_type === 'string' ? parsed.subagent_type : null
      const prompt = 'prompt' in parsed && typeof parsed.prompt === 'string' ? parsed.prompt : null
      return { kind, prompt }
    }
  } catch {
    // Cut short: fall through to the text as it is.
  }
  return { kind: null, prompt: input }
}

// Lines added and removed across a call's diffs, from the patches themselves.
export function diffCounts(diffs: readonly Pick<ChatDiff, 'patch'>[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const line of diff.patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  return { added, removed }
}

// How long a turn worked, as a person says it.
// How long a thought took: most last seconds, so tenths matter under a minute; minutes after.
export function thoughtFor(durationMs: number): string {
  return durationMs < 60_000 ? `${Math.max(0.1, durationMs / 1000).toFixed(1)} 秒` : workedFor(durationMs)
}

// How long a call has run, at a glance: tenths of a second under a minute, then minutes.
export function elapsedText(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : workedFor(ms)
}

// A token count at a glance: 842, 2.3k, 42k, 1.2M.
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

export function workedFor(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`
}
