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

// A pick as the input holds it: its short name over [start, end) of the text, in colour, and what
// it stands for, written out for the agent only as the message goes (see writeMentions).
export type Mention = { start: number; end: number; target: MentionTarget }
export type MentionedText = { text: string; mentions: readonly Mention[] }

// The name a pick shows in the input: the file's, folder's or project's own, a folder's with a slash.
export function mentionLabel(target: MentionTarget): string {
  const name = target.path.split(/[\\/]/).filter(Boolean).at(-1) ?? target.path
  return target.kind === 'directory' ? `${name}/` : name
}

// The mentions once [from, to) of the text is replaced by `inserted` characters: those before it
// stay, those after move with it, and any it reaches into go, their name no longer whole.
function spliceMentions(mentions: readonly Mention[], from: number, to: number, inserted: number): Mention[] {
  const delta = inserted - (to - from)
  return mentions.flatMap((mention) => mention.end <= from ? [mention]
    : mention.start >= to ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
      : [])
}

// The mentions carried from one text to the next, the change found between their common ends. A
// caret after the change (where typing leaves it) settles which of a run of equal characters was
// the one typed: the change ends at the caret, not further along.
export function shiftMentions(mentions: readonly Mention[], before: string, after: string, caret: number | null): Mention[] {
  if (mentions.length === 0 || before === after) return [...mentions]
  const most = Math.min(before.length, after.length)
  const suffixLimit = caret === null ? most : Math.max(0, Math.min(most, after.length - caret))
  let suffix = 0
  while (suffix < suffixLimit && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  let prefix = 0
  while (prefix < most - suffix && before[prefix] === after[prefix]) prefix++
  return spliceMentions(mentions, prefix, before.length - suffix, after.length - suffix - prefix)
}

// The input with the @word replaced by a pick's name, as insertMention places text, and where the
// caret goes.
export function placeMention(value: MentionedText, range: MentionRange, target: MentionTarget): { value: MentionedText; caret: number } {
  const label = mentionLabel(target)
  const placed = insertMention(value.text, range, label, true)
  const start = placed.caret - 1 - label.length
  const kept = spliceMentions(value.mentions, range.start, range.end, placed.text.length - value.text.length + (range.end - range.start))
  const mentions = [...kept, { start, end: start + label.length, target }].sort((a, b) => a.start - b.start)
  return { value: { text: placed.text, mentions }, caret: placed.caret }
}

// The message as the agent reads it: each name written out as mentionText has it, set apart from
// text running into it, since Claude takes an @path to the next space.
export function writeMentions(value: MentionedText, agent: AgentKind): string {
  let written = ''
  let at = 0
  for (const mention of [...value.mentions].sort((a, b) => a.start - b.start)) {
    written += value.text.slice(at, mention.start)
    const next = value.text[mention.end]
    const lead = written === '' || /\s$/.test(written) ? '' : ' '
    const trail = next === undefined || /\s/.test(next) ? '' : ' '
    written += lead + mentionText(mention.target, agent) + trail
    at = mention.end
  }
  return written + value.text.slice(at)
}

// Where a caret come to rest inside a mention (a click, a word's step) goes, as a mention is one
// piece: to its nearer end.
export function caretOutside(mentions: readonly Mention[], caret: number): number {
  const inside = mentions.find((mention) => mention.start < caret && caret < mention.end)
  if (!inside) return caret
  return caret - inside.start <= inside.end - caret ? inside.start : inside.end
}

// The mention a step from the caret (forward: to the right) would go into, which an arrow key steps
// over and Backspace or Delete takes whole.
export function mentionBeside(mentions: readonly Mention[], caret: number, forward: boolean): Mention | null {
  return mentions.find((mention) => (forward ? mention.start : mention.end) === caret) ?? null
}

// The text in runs for drawing: each a mention's name, part of what an input method is composing
// (`composing`, which the input marks itself only while its own text shows), or neither.
export type MarkedRun = { text: string; mention: boolean; composing: boolean }

export function markedRuns(text: string, mentions: readonly Mention[], composing: { start: number; end: number } | null): MarkedRun[] {
  const clamp = (at: number) => Math.max(0, Math.min(text.length, at))
  const edges = new Set([0, text.length])
  for (const mention of mentions) edges.add(clamp(mention.start)).add(clamp(mention.end))
  if (composing) edges.add(clamp(composing.start)).add(clamp(composing.end))
  const sorted = [...edges].sort((a, b) => a - b)
  const runs: MarkedRun[] = []
  for (let index = 0; index < sorted.length - 1; index++) {
    const from = sorted[index]!
    const to = sorted[index + 1]!
    if (from === to) continue
    runs.push({
      text: text.slice(from, to),
      mention: mentions.some((mention) => mention.start <= from && to <= mention.end),
      composing: composing !== null && composing.start <= from && to <= composing.end
    })
  }
  return runs
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
