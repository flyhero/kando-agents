import type { AgentKind, ProjectFileMatch } from '@kando/protocol'

const MAX_PROJECTS = 8

// The @word the caret is in: an @ not right after a letter or digit of a word (an address like
// me@host is no mention, but Chinese runs straight into one: 看看@README), what follows it up to the
// caret being the query, and the whole word being what a pick replaces.
export type MentionRange = { start: number; end: number; query: string }

export function mentionQuery(text: string, caret: number): MentionRange | null {
  const match = /(?:^|[^\w.-])@(\S*)$/.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? ''
  return { start: caret - query.length - 1, end: caret + rest.length, query }
}

// What a mention points at. `relative` is set only inside the agent's working folder, where the
// shorter path reads the same to it.
export type MentionTarget = { kind: 'file' | 'directory' | 'project'; path: string; relative: string | null }

export function fileTarget(match: ProjectFileMatch, cwd: string | null): MentionTarget {
  return { kind: match.kind, path: match.path, relative: match.root === cwd ? match.relative : null }
}

// Claude Code reads `@path` itself, attaching the file (a folder's listing); Codex has no file
// mentions, so it gets the path to read. A project is only named, for either.
export function mentionText(target: MentionTarget, agent: AgentKind): string {
  const shown = target.relative ?? target.path
  const written = target.kind === 'directory' ? `${shown}/` : shown
  const spaced = /\s/.test(written)
  if (agent === 'claude' && target.kind !== 'project') return spaced ? `@"${written}"` : `@${written}`
  return spaced ? `\`${written}\`` : written
}

// The text with the mention word replaced, and where the caret goes: past the space after it, so
// the menu does not open again on what was just put in. A folder being opened gets no space after.
// A space goes before it too where it follows other text: Claude takes @ only as a word's start.
export function insertMention(text: string, range: MentionRange, inserted: string, closing: boolean): { text: string; caret: number } {
  const before = text.slice(0, range.start)
  const lead = before === '' || /\s$/.test(before) ? before : `${before} `
  const after = text.slice(range.end)
  if (!closing) return { text: lead + inserted + after, caret: lead.length + inserted.length }
  const spaced = /^\s/.test(after) ? after : ` ${after}`
  return { text: lead + inserted + spaced, caret: lead.length + inserted.length + 1 }
}

// Projects whose folder name starts with the query, then those with it anywhere in their path.
export function matchProjects(paths: readonly string[], query: string): string[] {
  const needle = query.toLowerCase()
  const rank = (projectPath: string) => {
    const name = (projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath).toLowerCase()
    if (name.startsWith(needle)) return 0
    return projectPath.toLowerCase().includes(needle) ? 1 : -1
  }
  return paths
    .map((projectPath, index) => ({ projectPath, index, rank: rank(projectPath) }))
    .filter((each) => each.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_PROJECTS)
    .map((each) => each.projectPath)
}
