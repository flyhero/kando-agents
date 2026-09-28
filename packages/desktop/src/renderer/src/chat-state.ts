import { useMemo } from 'react'
import { create } from 'zustand'
import type { ChatItem, ConversationMessage, ConversationStage } from '@kando/protocol'

// A conversation's chat items as this window holds them, in the order core first saw them;
// `before` pages further back, null when nothing older is left.
export type ChatPage = { items: ChatItem[]; before: string | null }

// Only conversations a view is watching are here; core sends updates for those alone.
export const useChat = create<Record<string, ChatPage>>()(() => ({}))

// A plan Claude proposed from plan mode is the approval of its ExitPlanMode call.
export type PlanItem = Extract<ChatItem, { kind: 'approval' }>
const NO_PLANS: PlanItem[] = []

// The conversation's plans, oldest first, while a view watches it.
export function usePlans(conversationId: string): PlanItem[] {
  const items = useChat((s) => s[conversationId]?.items)
  return useMemo(
    () => items?.filter((item): item is PlanItem => item.kind === 'approval' && item.tool === 'ExitPlanMode') ?? NO_PLANS,
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
    // where the agent or the view changes.
    const restarted = previous?.mode === 'chat' && stage.mode === 'chat' && previous.agent === stage.agent
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

// Paths inside the conversation's projects read relative to them; with several projects, each
// keeps its folder's name in front.
export function pathShortener(roots: readonly string[]): (text: string) => string {
  const sorted = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)
  const name = (root: string) => root.split('/').filter(Boolean).at(-1) ?? root
  return (text) => sorted.reduce((current, root) => current.split(`${root}/`).join(sorted.length > 1 ? `${name(root)}/` : ''), text)
}
