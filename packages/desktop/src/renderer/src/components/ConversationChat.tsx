import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isPlanApproval, type ChatItem, type Conversation, type ConversationMessage, type ConversationStage } from '@kando/protocol'
import { chatBlocks, dropChat, finalReplies, itemKey, pathShortener, prependChatPage, previousTodos, setChatPage, thoughtDurations, timeline, useChat, type ChatBlock, type TimelineEntry, type TurnFile } from '../chat-state'
import { ChatDisclosureScope, setOpened, useDisclosure } from '../chat-disclosure'
import { isCompaction, noticeSummary, readableNotice } from '../chat-notices'
import { workedFor } from '../chat-tools'
import { perform, useCore } from '../core-store'
import { ChatSurfaceContext, conversationSurface, useChatSurface, type ChatSurface } from './chat-surface'
import { AGENT_LABEL, dayAndTime } from '../labels'
import { usePreferences } from '../preferences'
import { ChatDock } from './ChatDock'
import { ChatImageStrip } from './ChatImages'
import { ChatMarkdown, ChatRoots } from './ChatMarkdown'
import { ChatPlanLine } from './ChatPlan'
import { ChatRequestLine, type RequestItem } from './ChatRequestCards'
import { ChatSubagents } from './ChatSubagents'
import { ChatTodosLine, currentTodo, TodoHistory } from './ChatTodos'
import { ChatWorking } from './ChatWorking'
import { CopyButton } from './CopyButton'
import { ChatEditsCard, ChatPaths, ChatToolCard, ChatToolRun } from './ChatToolCard'
import { ArrowDownIcon, ChevronDownIcon, ChevronRightIcon, FileChangesIcon } from './icons'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const NO_ITEMS: ChatItem[] = []
// Within this many pixels of the bottom, new output keeps the list scrolled to the end.
const PINNED_SLACK = 48
// Scrolled back further than this, the list offers a way down to the latest.
const AWAY_SLACK = 240
// A message this close under the top edge already counts as the one in view.
const IN_VIEW_SLACK = 8

function turnText(item: Extract<ChatItem, { kind: 'turn' }>): string {
  const seconds = item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''
  if (item.state === 'completed') return `完成${seconds}`
  if (item.state === 'interrupted') return `已中断${item.error ? `：${item.error}` : ''}`
  return `失败${item.error ? `：${item.error}` : ''}`
}

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// A task's chat says where each stage ran: only planning beside the projects, or in its worktrees.
function StageDivider({ stage, task }: { stage: ConversationStage; task: boolean }) {
  const where = stage.mode !== 'chat' ? '终端，这里只有记下的消息，细节在终端记录里'
    : stage.planOnly ? '聊天界面 · 只读规划'
    : task ? '聊天界面 · 在 worktree 里执行'
    : '聊天界面'
  return <div className="chat-stage">{AGENT_LABEL[stage.agent]} · {dayAndTime(stage.startedAt)} · {where}</div>
}

// How long each finished thought took, by item key.
const Thoughts = createContext<ReadonlyMap<string, number>>(new Map())

type ReasoningItem = Extract<ChatItem, { kind: 'reasoning' }>

// A thought opens while it streams and closes a moment after, saying how long it took; once the
// user opens or closes it, it stays as they left it.
function Reasoning({ item }: { item: ReasoningItem }) {
  const took = useContext(Thoughts).get(itemKey(item))
  // Open while it streams and a moment after; open for good once the user opens it.
  const [kept, keep] = useDisclosure(`thought:${itemKey(item)}`)
  const [streaming, setStreaming] = useState(item.streaming)
  useEffect(() => {
    if (item.streaming) {
      setStreaming(true)
      return
    }
    const timer = setTimeout(() => setStreaming(false), 1000)
    return () => clearTimeout(timer)
  }, [item.streaming])
  const open = kept || streaming
  const label = item.streaming ? '思考中' : took !== undefined ? `思考了 ${workedFor(took)}` : '思考过程'
  return (
    <div className="chat-reasoning">
      <button
        type="button"
        className="chat-fold-header"
        aria-expanded={open}
        onClick={() => {
          keep(!open)
          if (open) setStreaming(false)
        }}
      >
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <span className={item.streaming ? 'chat-sheen' : undefined}>{label}</span>
      </button>
      {open && <div className="chat-reasoning-text">{item.text}</div>}
    </div>
  )
}

// While the chat is read: the shape of a message and a reply, pulsing one row after another.
function ChatSkeleton() {
  const rows = ['user', 'line', 'line', 'short', 'user', 'line', 'short']
  return (
    <div className="chat-skeleton" role="status" aria-label="正在读取聊天记录">
      {rows.map((row, index) => <span key={index} className="chat-skeleton-row" data-row={row} style={{ animationDelay: `${index * 120}ms` }} />)}
    </div>
  )
}

type UserItem = Extract<ChatItem, { kind: 'user' }>

// A long message the user sent, such as a task's first prompt, shows its start until opened.
function UserMessage({ item }: { item: UserItem }) {
  const [open, setOpen] = useDisclosure(`message:${itemKey(item)}`)
  const long = item.text.split('\n').length > 12 || item.text.length > 1200
  return (
    <>
      <div className="chat-user" data-clipped={(long && !open) || undefined}>
        <ChatImageStrip images={item.images} />
        {item.text}
      </div>
      {long && (
        <div className="chat-user-more">
          <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开全文'}
          </button>
        </div>
      )}
      {item.text && <div className="chat-message-actions" data-side="end"><CopyButton text={item.text} label="复制消息" /></div>}
    </>
  )
}

type NoticeItem = Extract<ChatItem, { kind: 'notice' }>

// A notice is one line, opening onto the rest; where the context was compacted is a divider.
function ChatNotice({ item }: { item: NoticeItem }) {
  const [open, setOpen] = useDisclosure(`notice:${itemKey(item)}`)
  if (isCompaction(item.text)) return <div className="chat-divider" role="separator">上下文已压缩</div>
  const text = readableNotice(item.text)
  const { first, more } = noticeSummary(text)
  if (!more) return <div className="chat-notice" data-level={item.level}>{text}</div>
  // The words stay out of the button, so an error's output can be selected and copied.
  return (
    <div className="chat-notice chat-notice-long" data-level={item.level}>
      <button type="button" className="chat-notice-toggle" aria-expanded={open} aria-label={open ? '收起' : '展开全文'} onClick={() => setOpen(!open)}>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      <div className="chat-notice-text" data-open={open || undefined} onClick={open ? undefined : () => setOpen(true)}>{open ? text : first}</div>
    </div>
  )
}

function TerminalMessage({ message }: { message: ConversationMessage }) {
  return message.role === 'user'
    ? <div className="chat-user">{message.text}</div>
    : <div className="chat-assistant"><ChatMarkdown text={message.text} /></div>
}

function Item({ conversationId, item, completedAt }: { conversationId: string; item: ChatItem; completedAt: number | undefined }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'assistant':
      return (
        <div className="chat-assistant" data-streaming={item.streaming || undefined}>
          <ChatMarkdown text={item.text} highlight={!item.streaming} />
          {completedAt !== undefined && item.text && (
            <div className="chat-message-actions">
              <CopyButton text={item.text} label="复制回复" />
              <time className="chat-message-time" dateTime={new Date(completedAt).toISOString()} title={dayAndTime(completedAt)}>{timeOfDay(completedAt)}</time>
            </div>
          )}
        </div>
      )
    case 'reasoning':
      return <Reasoning item={item} />
    case 'tool':
      return <ChatToolCard item={item} />
    case 'approval':
      return isPlanApproval(item) ? <ChatPlanLine item={item} /> : <ChatRequestLine item={item} />
    case 'question':
      return <ChatRequestLine item={item} />
    case 'turn':
      return <div className="chat-turn" data-state={item.state}>{turnText(item)}</div>
    case 'notice':
      return <ChatNotice item={item} />
    case 'todos':
      return <ChatTodosLine item={item} />
    case 'state':
      return null
  }
}

// The user's own messages are what ↑ steps back through.
function isUserEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'item' ? entry.item.kind === 'user' : entry.kind === 'message' && entry.message.role === 'user'
}

type TurnItem = Extract<ChatItem, { kind: 'turn' }>

// A finished turn's work, behind how long it took; opening it shows the calls, thinking and replies
// on the way to its answer.
function foldText(turn: TurnItem): string {
  const took = turn.durationMs !== null ? ` · ${workedFor(turn.durationMs)}` : ''
  const error = turn.error ? `：${readableNotice(turn.error)}` : ''
  if (turn.state === 'interrupted') return `已中断${took}${error}`
  if (turn.state === 'failed') return `失败${took}${error}`
  return `完成${took}`
}

// Opens a turn's work at one of the files it changed: for the list of them under its answer.
type FoldState = { reveal: (key: string | null, path: string) => void }
const Folds = createContext<FoldState>({ reveal: () => {} })

function TurnFold({ foldKey, conversationId, turn, blocks, task, replies, header }: { foldKey: string; conversationId: string; turn: TurnItem; blocks: readonly ChatBlock[]; task: boolean; replies: ReadonlyMap<string, number>; header: boolean }) {
  const [open, setOpen] = useDisclosure(foldKey)
  if (!header && !open) return null
  return (
    <div className="chat-entry">
      <div className="chat-fold" data-fold={foldKey} data-open={open || undefined} data-state={turn.state}>
        {header && (
          <button type="button" className="chat-fold-header" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
            {foldText(turn)}
          </button>
        )}
        {open && (
          <div className="chat-fold-body">
            {blocks.map((block) => <Block key={block.key} conversationId={conversationId} block={block} task={task} replies={replies} />)}
          </div>
        )}
      </div>
    </div>
  )
}

// The files a finished turn changed, under its answer: three up front, then the rest on demand.
// Each file opens the turn's work at that file's card; the inspector has them all.
function TurnChanges({ fold, files, turn, reply, collapsible }: { fold: string; files: readonly TurnFile[]; turn: TurnItem; reply: { text: string } | null; collapsible: boolean }) {
  const [showAll, setShowAll] = useDisclosure(`changes:${fold}`)
  const [workOpen, setWorkOpen] = useDisclosure(fold)
  const folds = useContext(Folds)
  const surface = useChatSurface()
  const shorten = useContext(ChatPaths)
  const { added, removed } = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 })
  const hidden = Math.max(files.length - 3, 0)
  const shown = showAll ? files : files.slice(0, 3)
  return (
    <div className="chat-turn-result">
      <div className="chat-changes-rollup">
        <div className="chat-changes-header">
          <span className="chat-changes-icon" aria-hidden="true"><FileChangesIcon /></span>
          <div className="chat-changes-summary">
            <strong>修改了 {files.length} 个文件</strong>
            <span className="chat-diff-count mono">
              <span className="chat-diff-added">+{added}</span>
              <span className="chat-diff-removed">−{removed}</span>
            </span>
          </div>
          {surface.changes && (
            <button type="button" className="button chat-changes-review" onClick={surface.showChanges} title="在检查器里查看项目的全部改动">
              审查
            </button>
          )}
        </div>
        <div className="chat-changes-files">
          {shown.map((file) => {
            const path = shorten(file.path)
            const slash = path.lastIndexOf('/')
            const directory = slash === -1 ? '' : path.slice(0, slash + 1)
            const name = slash === -1 ? path : path.slice(slash + 1)
            return (
              <button key={file.path} type="button" className="chat-changes-file" title={file.path} onClick={() => folds.reveal(collapsible ? fold : null, file.path)}>
                {file.change !== 'update' && (
                  <span className="chat-changes-kind" data-kind={file.change}>{file.change === 'add' ? '新建' : '删除'}</span>
                )}
                <span className="chat-changes-path mono">
                  {directory && <span className="chat-changes-directory">{directory}</span>}
                  <span className="chat-changes-name">{name}</span>
                </span>
                <span className="chat-diff-count mono">
                  <span className="chat-diff-added">+{file.added}</span>
                  <span className="chat-diff-removed">−{file.removed}</span>
                </span>
              </button>
            )
          })}
          {hidden > 0 && (
            <button type="button" className="chat-changes-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? '收起文件列表' : `显示另外 ${hidden} 个文件`}
              <span aria-hidden="true"><ChevronDownIcon /></span>
            </button>
          )}
        </div>
      </div>
      <div className="chat-message-actions chat-turn-actions">
        {reply && <CopyButton text={reply.text} label="复制回复" />}
        {reply && <time className="chat-message-time" dateTime={new Date(turn.at).toISOString()} title={dayAndTime(turn.at)}>{timeOfDay(turn.at)}</time>}
        {collapsible ? (
          <button type="button" className="chat-fold-header chat-turn-summary" aria-expanded={workOpen} onClick={() => setWorkOpen(!workOpen)}>
            <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
            {foldText(turn)}
          </button>
        ) : (
          <span className="chat-turn-summary-static" data-state={turn.state}>{foldText(turn)}</span>
        )}
      </div>
    </div>
  )
}

function Block({ conversationId, block, task, replies }: { conversationId: string; block: ChatBlock; task: boolean; replies: ReadonlyMap<string, number> }) {
  if (block.kind === 'tools') return <div className="chat-entry"><ChatToolRun tools={block.tools} /></div>
  if (block.kind === 'agents') return <div className="chat-entry"><ChatSubagents tools={block.tools} /></div>
  if (block.kind === 'edits') return <div className="chat-entry"><ChatEditsCard path={block.path} tools={block.tools} /></div>
  if (block.kind === 'changes') return <div className="chat-entry"><TurnChanges fold={block.fold} files={block.files} turn={block.turn} reply={block.reply} collapsible={block.collapsible} /></div>
  if (block.kind === 'fold') return <TurnFold foldKey={block.key} conversationId={conversationId} turn={block.turn} blocks={block.blocks} task={task} replies={replies} header={block.header} />
  const { entry } = block
  return (
    <div className="chat-entry" data-user={isUserEntry(entry) || undefined} data-entry-key={block.key}>
      {entry.kind === 'stage' ? <StageDivider stage={entry.stage} task={task} />
        : entry.kind === 'message' ? <TerminalMessage message={entry.message} />
        : <Item conversationId={conversationId} item={entry.item} completedAt={replies.get(block.key)} />}
    </div>
  )
}

// A conversation whose latest stage runs in chat mode: every stage in order, then the composer.
// What it does beyond itself comes from the surface it is shown on: a free conversation's own
// unless another is given, as a task's chat does.
export function ConversationChat({ conversation, surface }: { conversation: Conversation; surface?: ChatSurface }) {
  const { id } = conversation
  const width = usePreferences((s) => s.chatWidth)
  const own = useMemo(() => conversationSurface(conversation), [conversation])
  const shown = surface ?? own
  const rpc = useCore((s) => s.rpc)
  const page = useChat((s) => s[id])
  const [stages, setStages] = useState<ConversationStage[]>([])
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)

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
  const foldTurns = usePreferences((s) => s.foldTurns)
  const blocks = useMemo(() => chatBlocks(entries, { foldTurns }), [entries, foldTurns])
  const replies = useMemo(() => {
    const found = finalReplies(entries)
    // A turn with a change card moves these actions below that card.
    for (const block of blocks) {
      if (block.kind === 'changes' && block.reply) found.delete(block.reply.key)
    }
    return found
  }, [entries, blocks])
  const folds = useMemo<FoldState>(() => ({
    // Opens the turn's work, then brings the file's diff into view once it is there.
    reveal: (key, path) => {
      if (key) setOpened(id, key, true)
      pinned.current = false
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const scope = key ? list.current?.querySelector(`[data-fold="${CSS.escape(key)}"]`) : list.current
        scope?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }))
    }
  }), [id])
  const thoughts = useMemo(() => thoughtDurations(items), [items])
  const todoHistory = useMemo(() => previousTodos(items), [items])
  // What the user sent, in order, for the dock's list of them.
  const sent = useMemo(() => blocks.flatMap((block) => {
    if (block.kind !== 'entry' || !isUserEntry(block.entry)) return []
    const { entry } = block
    return [{ key: block.key, text: entry.kind === 'item' && entry.item.kind === 'user' ? entry.item.text : entry.kind === 'message' ? entry.message.text : '' }]
  }), [blocks])
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

  // Brings one of the user's messages into view, and marks it for a moment so the eye finds it.
  const jump = (key: string) => {
    const element = list.current
    const target = element?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"]`)
    if (!element || !target) return
    pinned.current = false
    element.scrollTo({ top: target.offsetTop - IN_VIEW_SLACK, behavior: 'smooth' })
    target.dataset.flash = ''
    setTimeout(() => delete target.dataset.flash, 1500)
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

  const roots = useMemo(
    () => (conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]),
    [conversation.projectPaths, conversation.workspacePath]
  )
  const shorten = useMemo(() => pathShortener(roots), [roots])
  const turn = conversation.sessionId ? (conversation.chat?.turn ?? null) : null
  const doing = state ? (state.activity ?? currentTodo(state.todos)) : null
  // A turn runs from the message that set it going.
  const since = useMemo(() => items.findLast((item) => item.kind === 'user')?.at ?? null, [items])
  return (
    <ChatSurfaceContext.Provider value={shown}>
    <ChatPaths.Provider value={shorten}>
    <ChatRoots.Provider value={roots}>
    <Thoughts.Provider value={thoughts}>
    <ChatDisclosureScope.Provider value={id}>
    <Folds.Provider value={folds}>
    <TodoHistory.Provider value={todoHistory}>
    <div className="chat-view" data-width={width}>
      <div
        className="chat-list"
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget
          const below = element.scrollHeight - element.scrollTop - element.clientHeight
          pinned.current = below < PINNED_SLACK
          setAway(below > AWAY_SLACK)
        }}
      >
        {page?.before && <button type="button" className="link-button chat-older" onClick={() => void loadOlder()}>加载更早的聊天记录</button>}
        {!page && <ChatSkeleton />}
        {blocks.map((block) => <Block key={block.key} conversationId={id} block={block} task={Boolean(conversation.taskId)} replies={replies} />)}
        {turn === 'running' && <ChatWorking agent={conversation.agent} doing={doing} since={since} />}
        {away && (
          <button
            type="button"
            className="chat-latest"
            onClick={() => {
              pinned.current = true
              list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ArrowDownIcon />
            回到最新
          </button>
        )}
      </div>
      <ChatDock conversation={conversation} state={state} pending={pending} tools={tools} finishedCalls={finishedCalls} onPrevious={previous} sent={sent} onJump={jump} />
    </div>
    </TodoHistory.Provider>
    </Folds.Provider>
    </ChatDisclosureScope.Provider>
    </Thoughts.Provider>
    </ChatRoots.Provider>
    </ChatPaths.Provider>
    </ChatSurfaceContext.Provider>
  )
}
