import type { ChatDiff, ChatItem } from '@kando/protocol'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Both agents' tool names, in words; an unknown one shows as the agent named it.
const TOOL_LABEL: Record<string, string> = {
  Bash: '命令',
  commandExecution: '命令',
  Read: '读取',
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
  ExitPlanMode: '计划'
}

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name
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

export function runSummary(tools: readonly Pick<ToolItem, 'name'>[]): string {
  const counts = new Map<string, { count: number; say: (count: number) => string }>()
  for (const tool of tools) {
    const known = TOOL_KIND[tool.name]
    const kind = known?.kind ?? `tool:${tool.name}`
    const say = known?.say ?? ((count: number) => `${toolLabel(tool.name)} ${count} 次`)
    const current = counts.get(kind)
    counts.set(kind, { count: (current?.count ?? 0) + 1, say })
  }
  return [...counts.values()].map(({ count, say }) => say(count)).join('，')
}

// A call that hands work to a subagent of its own: Claude's Task (Agent in newer versions), or a
// Codex spawn.
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
export function workedFor(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`
}
