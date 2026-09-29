import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isPlanApproval, type ChatItem, type Conversation, type ConversationMessage, type ConversationStage } from '@kando/protocol'
import { dropChat, itemKey, pathShortener, prependChatPage, setChatPage, timeline, useChat, type TimelineEntry } from '../chat-state'
import { perform, useCore } from '../core-store'
import { ChatSurfaceContext, conversationSurface, type ChatSurface } from './chat-surface'
import { AGENT_LABEL, dayAndTime } from '../labels'
import { ChatDock } from './ChatDock'
import { ChatImageStrip } from './ChatImages'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatPlanLine } from './ChatPlan'
import { ChatRequestLine, type RequestItem } from './ChatRequestCards'
import { ChatTodosLine, currentTodo } from './ChatTodos'
import { ChatPaths, ChatToolCard } from './ChatToolCard'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const NO_ITEMS: ChatItem[] = []
// Within this many pixels of the bottom, new output keeps the list scrolled to the end.
const PINNED_SLACK = 48
// A message this close under the top edge already counts as the one in view.
const IN_VIEW_SLACK = 8

function turnText(item: Extract<ChatItem, { kind: 'turn' }>): string {
  const seconds = item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''
  if (item.state === 'completed') return `完成${seconds}`
  if (item.state === 'interrupted') return `已中断${item.error ? `：${item.error}` : ''}`
  return `失败${item.error ? `：${item.error}` : ''}`
}

// A task's chat says where each stage ran: only planning beside the projects, or in its worktrees.
function StageDivider({ stage, task }: { stage: ConversationStage; task: boolean }) {
  const where = stage.mode !== 'chat' ? '终端，这里只有记下的消息，细节在终端记录里'
    : stage.planOnly ? '聊天界面 · 只读规划'
    : task ? '聊天界面 · 在 worktree 里执行'
    : '聊天界面'
  return <div className="chat-stage">{AGENT_LABEL[stage.agent]} · {dayAndTime(stage.startedAt)} · {where}</div>
}

function TerminalMessage({ message }: { message: ConversationMessage }) {
  return message.role === 'user'
    ? <div className="chat-user">{message.text}</div>
    : <div className="chat-assistant"><ChatMarkdown text={message.text} /></div>
}

function Item({ conversationId, item }: { conversationId: string; item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="chat-user">
          <ChatImageStrip images={item.images} />
          {item.text}
        </div>
      )
    case 'assistant':
      return <div className="chat-assistant" data-streaming={item.streaming || undefined}><ChatMarkdown text={item.text} /></div>
    case 'reasoning':
      return (
        <details className="chat-reasoning">
          <summary className="muted">思考过程</summary>
          <div className="chat-reasoning-text">{item.text}</div>
        </details>
      )
    case 'tool':
      return <ChatToolCard item={item} />
    case 'approval':
      return isPlanApproval(item) ? <ChatPlanLine item={item} /> : <ChatRequestLine item={item} />
    case 'question':
      return <ChatRequestLine item={item} />
    case 'turn':
      return <div className="chat-turn" data-state={item.state}>{turnText(item)}</div>
    case 'notice':
      return <div className="chat-notice" data-level={item.level}>{item.text}</div>
    case 'todos':
      return <ChatTodosLine item={item} />
    case 'state':
      return null
  }
}

function entryKey(entry: TimelineEntry): string {
  return entry.kind === 'stage' ? `stage:${entry.stage.id}` : entry.kind === 'item' ? `item:${itemKey(entry.item)}` : `message:${entry.message.sequence}`
}

// The user's own messages are what ↑ steps back through.
function isUserEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'item' ? entry.item.kind === 'user' : entry.kind === 'message' && entry.message.role === 'user'
}

// A conversation whose latest stage runs in chat mode: every stage in order, then the composer.
// What it does beyond itself comes from the surface it is shown on: a free conversation's own
// unless another is given, as a task's chat does.
export function ConversationChat({ conversation, surface }: { conversation: Conversation; surface?: ChatSurface }) {
  const { id } = conversation
  const own = useMemo(() => conversationSurface(conversation), [conversation])
  const shown = surface ?? own
  const rpc = useCore((s) => s.rpc)
  const page = useChat((s) => s[id])
  const [stages, setStages] = useState<ConversationStage[]>([])
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Watching makes core send this conversation's item changes to this window until it lets go.
  useEffect(() => {
    if (!rpc) return
    let current = true
    rpc.call('conversations.watchChat', { id }).then(
      (result) => current && setChatPage(id, result),
      () => {}
    )
    return () => {
      current = false
      dropChat(id)
      void rpc.call('conversations.unwatchChat', { id }).catch(() => {})
    }
  }, [rpc, id])

  // A new stage starts with a new session; earlier stages and their messages do not change.
  useEffect(() => {
    if (!rpc) return
    let current = true
    Promise.all([rpc.call('conversations.stages', { id }), rpc.call('conversations.messages', { id })]).then(
      ([nextStages, nextMessages]) => {
        if (!current) return
        setStages(nextStages)
        setMessages(nextMessages)
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [rpc, id, conversation.sessionId])

  const items = page?.items ?? NO_ITEMS
  const entries = useMemo(() => {
    // A plan shows with its approval; the call's own card would only repeat it.
    const plans = new Set(items.flatMap((item) =>
      item.kind === 'approval' && isPlanApproval(item) && item.toolItemId ? [itemKey({ stageId: item.stageId, id: item.toolItemId })] : []))
    return timeline(stages, messages, items).filter((entry) => entry.kind !== 'item' || !plans.has(itemKey(entry.item)))
  }, [stages, messages, items])
  const tools = useMemo(
    () => new Map(items.flatMap((item) => (item.kind === 'tool' ? [[item.id, item] as const] : []))),
    [items]
  )
  const pending = useMemo(
    () => items.filter((item): item is RequestItem => (item.kind === 'approval' || item.kind === 'question') && item.resolution === null),
    [items]
  )
  const finishedCalls = useMemo(() => items.filter((item) => item.kind === 'tool' && item.status !== 'running').length, [items])
  // Each stage has one; the running stage's is the newest.
  const state = useMemo(() => items.findLast((item): item is Extract<ChatItem, { kind: 'state' }> => item.kind === 'state') ?? null, [items])

  // A plan the agent proposes opens beside the conversation, once; the user may close it again.
  const waitingPlan = pending.find(isPlanApproval)
  const waitingPlanKey = waitingPlan ? itemKey(waitingPlan) : null
  const shownPlan = useRef<string | null>(null)
  const showPlan = shown.showPlan
  useEffect(() => {
    if (!waitingPlanKey || shownPlan.current === waitingPlanKey) return
    shownPlan.current = waitingPlanKey
    showPlan(waitingPlanKey)
  }, [waitingPlanKey, showPlan])

  useLayoutEffect(() => {
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [entries])

  // A request docking below makes the list shorter; one pinned to the end stays there.
  useEffect(() => {
    const element = list.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Scrolls to the nearest of the user's messages above what is in view.
  const previous = () => {
    const element = list.current
    if (!element) return
    const top = element.scrollTop
    const above = [...element.querySelectorAll<HTMLElement>('[data-user]')].filter((entry) => entry.offsetTop < top - IN_VIEW_SLACK)
    const target = above.at(-1)
    if (!target) return
    pinned.current = false
    element.scrollTo({ top: target.offsetTop - IN_VIEW_SLACK, behavior: 'smooth' })
  }

  const loadOlder = async () => {
    if (!page?.before) return
    const before = page.before
    const older = await perform((connection) => connection.call('conversations.chatItems', { id, before }))
    if (older) {
      pinned.current = false
      prependChatPage(id, older)
    }
  }

  const shorten = useMemo(
    () => pathShortener(conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]),
    [conversation.projectPaths, conversation.workspacePath]
  )
  const turn = conversation.sessionId ? (conversation.chat?.turn ?? null) : null
  const doing = state ? (state.activity ?? currentTodo(state.todos)) : null
  return (
    <ChatSurfaceContext.Provider value={shown}>
    <ChatPaths.Provider value={shorten}>
    <div className="chat-view">
      <div
        className="chat-list"
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK
        }}
      >
        {page?.before && <button type="button" className="link-button chat-older" onClick={() => void loadOlder()}>加载更早的聊天记录</button>}
        {!page && <p className="muted chat-empty">正在读取聊天记录…</p>}
        {entries.map((entry) => (
          <div key={entryKey(entry)} className="chat-entry" data-user={isUserEntry(entry) || undefined}>
            {entry.kind === 'stage' ? <StageDivider stage={entry.stage} task={Boolean(conversation.taskId)} />
              : entry.kind === 'message' ? <TerminalMessage message={entry.message} />
              : <Item conversationId={id} item={entry.item} />}
          </div>
        ))}
        {turn === 'running' && <div className="chat-working muted">{AGENT_LABEL[conversation.agent]} 正在处理{doing ? `：${doing}` : ''}…</div>}
      </div>
      <ChatDock conversation={conversation} state={state} pending={pending} tools={tools} finishedCalls={finishedCalls} onPrevious={previous} />
    </div>
    </ChatPaths.Provider>
    </ChatSurfaceContext.Provider>
  )
}
