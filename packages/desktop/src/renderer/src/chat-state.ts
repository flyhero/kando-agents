import { useMemo } from 'react'
import { create } from 'zustand'
import { isPlanApproval, type ChatItem, type ChatQuestion, type ConversationMessage, type ConversationStage } from '@kando/protocol'

// A conversation's chat items as this window holds them, in the order core first saw them;
// `before` pages further back, null when nothing older is left.
export type ChatPage = { items: ChatItem[]; before: string | null }

// Only conversations a view is watching are here; core sends updates for those alone.
export const useChat = create<Record<string, ChatPage>>()(() => ({}))

// A plan from plan mode waits as an approval: Claude's ExitPlanMode call, or the plan a Codex
// plan-mode turn ended with.
export type PlanItem = Extract<ChatItem, { kind: 'approval' }>
const NO_PLANS: PlanItem[] = []

// The conversation's plans, oldest first, while a view watches it.
export function usePlans(conversationId: string): PlanItem[] {
  const items = useChat((s) => s[conversationId]?.items)
  return useMemo(
    () => items?.filter((item): item is PlanItem => item.kind === 'approval' && isPlanApproval(item)) ?? NO_PLANS,
    [items]
  )
}

// Item ids are unique within their stage only: each stage numbers its notices and requests afresh.
export function itemKey(item: Pick<ChatItem, 'stageId' | 'id'>): string {
  return `${item.stageId}/${item.id}`
}

// A known item is replaced where it stands, a new one goes last: core sends items in order.
export function mergeItems(current: readonly ChatItem[], incoming: readonly ChatItem[]): ChatItem[] {
  const next = [...current]
  const index = new Map(next.map((item, position) => [itemKey(item), position]))
  for (const item of incoming) {
    const position = index.get(itemKey(item))
    if (position === undefined) {
      index.set(itemKey(item), next.length)
      next.push(item)
    } else {
      next[position] = item
    }
  }
  return next
}

// Without a stage (an older core), the id alone decides; streamed items carry provider-unique ids.
export function appendText(items: readonly ChatItem[], stageId: string | undefined, itemId: string, text: string): ChatItem[] {
  return items.map((item) =>
    item.id === itemId && (stageId === undefined || item.stageId === stageId) && (item.kind === 'assistant' || item.kind === 'reasoning')
      ? { ...item, text: item.text + text }
      : item
  )
}

export function setChatPage(conversationId: string, page: ChatPage): void {
  useChat.setState({ [conversationId]: page })
}

// An older page goes in front; anything it shares with what is shown keeps the newer copy.
export function prependChatPage(conversationId: string, page: ChatPage): void {
  useChat.setState((state) => {
    const current = state[conversationId]
    if (!current) return {}
    const shown = new Set(current.items.map(itemKey))
    return { [conversationId]: { items: [...page.items.filter((item) => !shown.has(itemKey(item))), ...current.items], before: page.before } }
  })
}

export function receiveChatItems(conversationId: string, items: readonly ChatItem[]): void {
  useChat.setState((state) => {
    const current = state[conversationId]
    return current ? { [conversationId]: { ...current, items: mergeItems(current.items, items) } } : {}
  })
}

export function receiveChatDelta(conversationId: string, stageId: string | undefined, itemId: string, append: string): void {
  useChat.setState((state) => {
    const current = state[conversationId]
    return current ? { [conversationId]: { ...current, items: appendText(current.items, stageId, itemId, append) } } : {}
  })
}

export function dropChat(conversationId: string): void {
  useChat.setState((state) => {
    const { [conversationId]: _dropped, ...rest } = state
    return rest
  }, true)
}

export type TimelineEntry =
  | { kind: 'stage'; stage: ConversationStage }
  | { kind: 'item'; item: ChatItem }
  // A message a TUI stage's hooks recorded: all there is of that stage outside its terminal.
  | { kind: 'message'; message: ConversationMessage }

// The conversation stage by stage: chat stages as their items, TUI stages as their messages.
export function timeline(
  stages: readonly ConversationStage[],
  messages: readonly ConversationMessage[],
  items: readonly ChatItem[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const known = new Set(stages.map((stage) => stage.id))
  // A stage's state item feeds the composer; it is not something that happened.
  const flow = items.filter((item) => item.kind !== 'state')
  let previous: ConversationStage | null = null
  for (const stage of stages) {
    // An idle chat agent goes and the next message starts it again: no divider for that, only
    // where the agent, the view or a task's planning-only turn changes.
    const restarted = previous?.mode === 'chat' && stage.mode === 'chat' && previous.agent === stage.agent &&
      Boolean(previous.planOnly) === Boolean(stage.planOnly)
    if (!restarted) entries.push({ kind: 'stage', stage })
    previous = stage
    if (stage.mode === 'chat') {
      flow.filter((item) => item.stageId === stage.id).forEach((item) => entries.push({ kind: 'item', item }))
    } else {
      messages.filter((message) => message.stageId === stage.id).forEach((message) => entries.push({ kind: 'message', message }))
    }
  }
  // A stage that began after the list was read.
  flow.filter((item) => !known.has(item.stageId)).forEach((item) => entries.push({ kind: 'item', item }))
  return entries
}

export function entryKey(entry: TimelineEntry): string {
  return entry.kind === 'stage' ? `stage:${entry.stage.id}` : entry.kind === 'item' ? `item:${itemKey(entry.item)}` : `message:${entry.message.sequence}`
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type TurnItem = Extract<ChatItem, { kind: 'turn' }>

// What the conversation shows once its work is grouped: calls made one after another as one run,
// and a finished turn's work folded behind one line, leaving its answer in view.
export type ChatBlock =
  | { kind: 'entry'; key: string; entry: TimelineEntry }
  | { kind: 'tools'; key: string; tools: ToolItem[] }
  | { kind: 'fold'; key: string; turn: TurnItem; blocks: ChatBlock[] }

// A call that changed files keeps its own card, with its diff; the rest run together.
function runTool(entry: TimelineEntry): ToolItem | null {
  return entry.kind === 'item' && entry.item.kind === 'tool' && entry.item.diffs.length === 0 ? entry.item : null
}

function itemOf(block: ChatBlock): ChatItem | null {
  return block.kind === 'entry' && block.entry.kind === 'item' ? block.entry.item : null
}

// What a finished turn tucks away: the work on the way to its answer. What the user was asked, a
// plan, and anything that went wrong stay in view.
function foldable(block: ChatBlock): boolean {
  const item = itemOf(block)
  if (!item) return block.kind !== 'entry'
  switch (item.kind) {
    case 'tool':
    case 'reasoning':
    case 'assistant':
    case 'todos':
      return true
    case 'approval':
      return !isPlanApproval(item)
    case 'notice':
      return item.level === 'info'
    default:
      return false
  }
}

function foldTurn(body: ChatBlock[], turn: TurnItem, end: ChatBlock): ChatBlock[] {
  // The answer is the replies it ends with, after the last of its work.
  const reply = (block: ChatBlock | undefined) => block !== undefined && itemOf(block)?.kind === 'assistant'
  let answer = body.length
  while (answer > 0 && reply(body[answer - 1])) answer--
  const work = body.slice(0, answer)
  const folded = work.filter(foldable)
  if (folded.length === 0) return [...body, end]
  return [{ kind: 'fold', key: `fold:${end.key}`, turn, blocks: folded }, ...work.filter((block) => !foldable(block)), ...body.slice(answer)]
}

export function chatBlocks(entries: readonly TimelineEntry[]): ChatBlock[] {
  const runs: ChatBlock[] = []
  for (const entry of entries) {
    // Claude often thinks without saying anything it keeps.
    if (entry.kind === 'item' && entry.item.kind === 'reasoning' && !entry.item.streaming && !entry.item.text.trim()) continue
    const tool = runTool(entry)
    const last = runs.at(-1)
    if (tool && last?.kind === 'tools') last.tools.push(tool)
    else if (tool) runs.push({ kind: 'tools', key: `tools:${entryKey(entry)}`, tools: [tool] })
    else runs.push({ kind: 'entry', key: entryKey(entry), entry })
  }
  // Each turn runs from the user's message, or a new stage, to the item that says how it ended.
  const blocks: ChatBlock[] = []
  let body: ChatBlock[] = []
  for (const block of runs) {
    const item = itemOf(block)
    const boundary = block.kind === 'entry' && (block.entry.kind !== 'item' || item?.kind === 'user')
    if (boundary) {
      blocks.push(...body, block)
      body = []
    } else if (item?.kind === 'turn') {
      blocks.push(...foldTurn(body, item, block))
      body = []
    } else {
      body.push(block)
    }
  }
  return [...blocks, ...body]
}

// Paths inside the conversation's projects read relative to them; with several projects, each
// keeps its folder's name in front.
export function pathShortener(roots: readonly string[]): (text: string) => string {
  const sorted = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)
  const name = (root: string) => root.split('/').filter(Boolean).at(-1) ?? root
  return (text) => sorted.reduce((current, root) => current.split(`${root}/`).join(sorted.length > 1 ? `${name(root)}/` : ''), text)
}

// An answer as the question card shows it: an option picked, or words of the user's own.
export type QuestionAnswer = { text: string; typed: boolean }

// Claude hands a multi-select answer back as one "A, B" string: read the options it starts with as
// options, and what follows as typed.
export function questionAnswers(question: ChatQuestion, answers: readonly string[]): QuestionAnswer[] {
  const labels = new Set(question.options.map((option) => option.label))
  return answers.flatMap((answer) => {
    if (labels.has(answer)) return [{ text: answer, typed: false }]
    const parts = answer.split(', ')
    const typedFrom = parts.findIndex((part) => !labels.has(part))
    const picked = (typedFrom === -1 ? parts : parts.slice(0, typedFrom)).map((text) => ({ text, typed: false }))
    const typed = typedFrom === -1 ? [] : [{ text: parts.slice(typedFrom).join(', '), typed: true }]
    return [...picked, ...typed]
  })
}
