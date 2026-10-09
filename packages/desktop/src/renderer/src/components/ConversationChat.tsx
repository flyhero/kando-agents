import { Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isBrowserTool, isPlanApproval, isPreviewTool, toolImagePath, type AgentKind, type ChatItem, type Conversation, type ConversationStage } from '@kando/protocol'
import { firstBrowserCall, shouldOpenBrowser } from '../browser-state'
import { ChatBrowserCard, ChatShotCard } from './ChatBrowserCard'
import { foldRowKeys, chatBlocks, dropChat, finalReplies, itemKey, pathShortener, prependChatPage, previousTodos, setChatPage, thoughtDurations, timeline, useChat, type ChatBlock, type TimelineEntry, type TurnFile } from '../chat-state'
import { ChatDisclosureScope, setOpened, useDisclosure } from '../chat-disclosure'
import { isCompaction, noticeSummary, readableNotice } from '../chat-notices'
import { parseQuotes, withoutQuoteMarkers } from '../chat-quotes'
import { formatTokens, isSubagent, thoughtFor, workedFor } from '../chat-tools'
import { perform, useCore } from '../core-store'
import { ChatSurfaceContext, conversationSurface, useChatSurface, type ChatSurface } from './chat-surface'
import { forkConversation } from './ConversationActions'
import { AGENT_LABEL, chatDayAndTime, dayAndTime, messageTime } from '../labels'
import { usePreferences } from '../preferences'
import { ChatDock } from './ChatDock'
import { ChatImageStrip } from './ChatImages'
import { ChatMarkdown, ChatRoots } from './ChatMarkdown'
import { ChatFilesContext, useChatContextMenu } from './ChatContextMenu'
import { ChatCopyRegion } from './ChatCopyRegion'
import { copyTextForItem } from '../message-copy'
import { ChatRunScope } from './ChatCodeRun'
import { ChatPlanLine } from './ChatPlan'
import { ChatRequestLine, type RequestItem } from './ChatRequestCards'
import { ChatSubagents } from './ChatSubagents'
import { ChatTodosLine, TodoHistory } from './ChatTodos'
import { ChatUsageLimitEntry } from './ChatUsageLimit'
import { ChatWorking, type WorkingPhase } from './ChatWorking'
import { CopyButton } from './CopyButton'
import { ChatEditsCard, ChatPaths, ChatToolCard, ChatToolRun } from './ChatToolCard'
import { ChatPreviewCard } from './ChatPreviewCard'
import { ChatQuotePicker } from './ChatQuotePicker'
import { effortLabel } from './ChatOptionsBar'
import { ChatMessageRelay, useMessageRelay } from './chat-message-relay'
import { cssFontFamily } from '../system-fonts'
import { freshKeys } from '../chat-motion'
import { acknowledgeInitialMessage, sendInitialMessage, useInitialMessages, type InitialMessage } from '../initial-messages'
import { Spinner } from './Spinner'
import { ArrowDownIcon, ChevronDownIcon, ChevronRightIcon, FileChangesIcon, AgentIcon, ForkIcon } from './icons'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const NO_ITEMS: ChatItem[] = []
// Within this many pixels of the bottom, new output keeps the list scrolled to the end.
const PINNED_SLACK = 48
// Scrolled back further than this, the list offers a way down to the latest.
const AWAY_SLACK = 240
// A message this close under the top edge already counts as the one in view.
const IN_VIEW_SLACK = 8

// What a turn sent and received, when the agent counted: "↑ 42k ↓ 6.8k".
function tokensText(item: Extract<ChatItem, { kind: 'turn' }>): string {
  if (!item.usage) return ''
  return 'total' in item.usage
    ? ` · 总 ${formatTokens(item.usage.total)} tokens`
    : ` · ↑ ${formatTokens(item.usage.input)} ↓ ${formatTokens(item.usage.output)}`
}

// How a turn ended, how long it ran and what it cost: the one place the turn's totals read.
function turnText(item: Extract<ChatItem, { kind: 'turn' }>): string {
  const took = (item.durationMs !== null ? ` · ${workedFor(item.durationMs)}` : '') + tokensText(item)
  // What opened a turn of the agent's own; an older core, or an agent that does not say, leaves it unnamed.
  const why = !item.resumed ? '' : item.resumedBy === 'command' ? '后台命令结束后继续，' : item.resumedBy === 'subagent' ? '子 Agent 回来后继续，' : '自动继续，'
  if (item.state === 'completed') return `${why}完成${took}`
  if (item.state === 'interrupted') return `${why}已中断${took}${item.error ? `：${readableNotice(item.error)}` : ''}`
  return `${why}失败${took}${item.error ? `：${readableNotice(item.error)}` : ''}`
}

function MessageTime({ at }: { at: number }) {
  return <time className="chat-message-time" dateTime={new Date(at).toISOString()} title={dayAndTime(at)}>{messageTime(at)}</time>
}

// A task's chat says where each stage ran: only planning beside the projects, or in its worktrees.
function StageDivider({ stage, task }: { stage: ConversationStage; task: boolean }) {
  const where = stage.planOnly ? ' · 只读规划' : task ? ' · 在 worktree 里执行' : ''
  return <div className="chat-stage">{AGENT_LABEL[stage.agent]} · {chatDayAndTime(stage.startedAt)}{where}</div>
}

// How long each finished thought took, by item key.
const Thoughts = createContext<ReadonlyMap<string, number>>(new Map())

// The turn item that closes a final reply, by the reply's block key: its outcome reads on the
// reply's own line of actions, and the turn's own line is left out.
const Endings = createContext<ReadonlyMap<string, TurnItem>>(new Map())
const MergedTurns = createContext<ReadonlySet<string>>(new Set())

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
  const label = item.streaming ? '思考中' : took !== undefined ? `思考了 ${thoughtFor(took)}` : '思考过程'
  // While it streams, the thought keeps its newest line in view, as the agent writes it.
  const text = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = text.current
    if (item.streaming && element) element.scrollTop = element.scrollHeight
  }, [item.text, item.streaming, open])
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
      {open && (
        <div className="chat-reasoning-body" data-streaming={item.streaming || undefined}>
          <div ref={text} className="chat-reasoning-text">{item.text}</div>
        </div>
      )}
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

// Scrolls the chat to an entry and marks it a moment: for a quote, back to the passage it took.
const JumpToEntry = createContext<(key: string) => void>(() => {})

// Forks the conversation at this item, where the chat's owner allows it: a new conversation that
// holds the chat to here (through the turn for an agent's reply; before the message, which then
// waits in the input, for the user's).
function ForkButton({ item }: { item: ChatItem }) {
  const surface = useChatSurface()
  if (!surface.fork) return null
  const label = item.kind === 'user' ? '从这条消息 fork：新会话到它之前为止，这条消息留在输入框里' : '从这里 fork：新会话到这一轮为止'
  return (
    <button type="button" className="copy-button fork-button" aria-label="fork" data-tooltip={label} onClick={() => surface.fork?.(item)}>
      <ForkIcon />
    </button>
  )
}

function UserMessageFooter({ item }: { item: UserItem }) {
  return (
    <div className="chat-user-footer">
      <MessageTime at={item.at} />
      {item.text && <CopyButton text={withoutQuoteMarkers(item.text)} label="复制消息" />}
      <ForkButton item={item} />
    </div>
  )
}

// The passages a message quotes, over what it says: each opens the reply it came from, where that
// is still in the chat.
function UserQuotes({ quotes }: { quotes: ReturnType<typeof parseQuotes>['quotes'] }) {
  const jump = useContext(JumpToEntry)
  return (
    <div className="chat-user-quotes">
      {quotes.map((quote, index) => (
        <div key={index} className="chat-user-quote">
          <button type="button" className="chat-user-quote-text" disabled={!quote.source} title={quote.source ? '跳到引用的原文' : undefined} onClick={() => quote.source && jump(quote.source)}>
            {quote.text}
          </button>
          {quote.note && <div className="chat-user-quote-note">{quote.note}</div>}
        </div>
      ))}
    </div>
  )
}

// A long message the user sent, such as a task's first prompt, shows its start until opened.
function UserMessage({ item, pending = false }: { item: UserItem; pending?: boolean }) {
  const [open, setOpen] = useDisclosure(`message:${itemKey(item)}`)
  const { quotes, body } = parseQuotes(item.text)
  const long = body.split('\n').length > 12 || body.length > 1200
  return (
    <>
      <div className="chat-user" data-clipped={(long && !open) || undefined} data-steer={item.steer || undefined}>
        {item.steer && <span className="chat-user-steer" title="回合进行中插入的消息">追加指令</span>}
        <ChatImageStrip images={item.images} />
        {quotes.length > 0 && <UserQuotes quotes={quotes} />}
        {body}
      </div>
      {long && (
        <div className="chat-user-more">
          <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开全文'}
          </button>
        </div>
      )}
      {!pending && <UserMessageFooter item={item} />}
    </>
  )
}

function InitialMessageEntry({ id, agent, message }: { id: string; agent: AgentKind; message: InitialMessage }) {
  const rpc = useCore((state) => state.rpc)
  return (
    <>
      <div className="chat-entry" data-user>
        <UserMessage pending item={{ kind: 'user', id: `u:${message.ref}`, stageId: 'pending', revision: 0, at: message.at, text: message.text, images: message.images }} />
      </div>
      {message.phase === 'failed' ? (
        <div className="chat-initial-error chat-notice" data-level="error" role="alert">
          <span>首条消息未发送：{message.error}</span>
          <button type="button" className="button ghost" disabled={!rpc} onClick={() => { if (rpc) void sendInitialMessage(id, rpc) }}>重试</button>
        </div>
      ) : (
        <div className="chat-working" role="status">
          <Spinner />
          <span>{message.phase === 'starting' ? `正在启动 ${AGENT_LABEL[agent]}…` : '正在发送首条消息…'}</span>
        </div>
      )}
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

function Item({ conversationId, item, completedAt, blockKey }: { conversationId: string; item: ChatItem; completedAt: number | undefined; blockKey: string }) {
  const ending = useContext(Endings).get(blockKey)
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'assistant':
      return (
        <div className="chat-assistant" data-streaming={item.streaming || undefined}>
          <ChatMarkdown text={item.text} highlight={!item.streaming} runnable={!item.streaming} />
          {completedAt !== undefined && item.text && (
            <div className="chat-message-actions">
              <CopyButton text={item.text} label="复制回复" />
              <MessageTime at={completedAt} />
              {ending && <span className="chat-turn chat-turn-inline" data-state={ending.state}>{turnText(ending)}</span>}
              <ForkButton item={item} />
            </div>
          )}
        </div>
      )
    case 'reasoning':
      return <Reasoning item={item} />
    case 'tool':
      if (isPreviewTool(item.name)) return <ChatPreviewCard conversationId={conversationId} item={item} />
      if (isBrowserTool(item.name)) return <ChatBrowserCard item={item} />
      return item.images?.length || toolImagePath(item) ? <ChatShotCard item={item} /> : <ChatToolCard item={item} />
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
    case 'usageLimit':
      return <ChatUsageLimitEntry conversationId={conversationId} item={item} />
    case 'state':
      return null
  }
}

// Who answers and on what: for the head that opens each of the agent's turns.
const ChatAgent = createContext<{ agent: Conversation['agent']; model: string | null; effort: string | null }>({ agent: 'claude', model: null, effort: null })

// Opens the agent's turn under the user's message: its icon and name, the model it runs and how
// hard it reasons, and when the message it answers came in. While that turn runs, a ring turns around the icon; one waiting
// on the user holds it still, in the colour of the request.
function TurnHead({ at, messageKey, live }: { at: number; messageKey: string; live: 'running' | 'awaiting' | null }) {
  const { agent, model, effort } = useContext(ChatAgent)
  return (
    <div className="chat-turn-head" data-relay-for={messageKey}>
      <span className="chat-turn-head-icon" data-live={live ?? undefined} aria-hidden="true"><AgentIcon agent={agent} /></span>
      <span className="chat-turn-head-name">{AGENT_LABEL[agent]}</span>
      {model && <span className="chat-turn-head-model" title={`模型：${model}`}>{model}</span>}
      {model && effort && <span className="chat-turn-head-effort" title={`推理程度：${effortLabel(effort)}`}>{effortLabel(effort)}</span>}
      <MessageTime at={at} />
    </div>
  )
}

// The user's message a block is, if it is one: the head goes under it.
function userAt(block: ChatBlock): number | null {
  const item = block.kind === 'entry' && block.entry.kind === 'item' ? block.entry.item : null
  return item?.kind === 'user' ? item.at : null
}

// The user's own messages are what ↑ steps back through.
function isUserEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'item' && entry.item.kind === 'user'
}

type TurnItem = Extract<ChatItem, { kind: 'turn' }>

// A finished turn's work, behind how long it took; opening it shows the calls, thinking and replies
// on the way to its answer.
// The turn's work in one line: how many calls, and how long they ran before the answer. The kinds
// of call are the expanded list's business, and the turn's outcome and cost read under the answer.
function foldText(steps: number, workMs: number | null): string {
  return [steps > 0 ? `${steps} 步` : '工作过程', workMs !== null ? workedFor(workMs) : null].filter(Boolean).join(' · ')
}

// Opens a turn's work at one of the files it changed: for the list of them under its answer.
type FoldState = { reveal: (key: string | null, path: string) => void }
const Folds = createContext<FoldState>({ reveal: () => {} })

function TurnFold({ foldKey, conversationId, turn, blocks, task, replies, steps, workMs }: { foldKey: string; conversationId: string; turn: TurnItem; blocks: readonly ChatBlock[]; task: boolean; replies: ReadonlyMap<string, number>; steps: number; workMs: number | null }) {
  const [open, setOpen] = useDisclosure(foldKey)
  // Open, the work is a list of rows, each closed until asked; a second step opens them all.
  const [allOpen, setAllOpen] = useDisclosure(`all:${foldKey}`)
  const rows = useMemo(() => foldRowKeys(blocks), [blocks])
  const openAll = (next: boolean) => {
    setAllOpen(next)
    for (const key of rows) setOpened(conversationId, key, next)
  }
  // The header stays where the work is, so the fold opens under the line that opened it.
  return (
    <div className="chat-entry">
      <div className="chat-fold" data-fold={foldKey} data-open={open || undefined} data-state={turn.state}>
        <button type="button" className="chat-fold-header" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
          {foldText(steps, workMs)}
        </button>
        {open && (
          <div className="chat-fold-body">
            {rows.length > 1 && (
              <div className="chat-fold-bar">
                <button type="button" className="link-button" onClick={() => openAll(!allOpen)}>{allOpen ? '收起每一步' : '展开每一步'}</button>
              </div>
            )}
            {blocks.map((block) => <Block key={block.key} conversationId={conversationId} block={block} task={task} replies={replies} />)}
          </div>
        )}
      </div>
    </div>
  )
}

// The files a finished turn changed, under its answer: three up front, then the rest on demand.
// Each file opens its current diff in the inspector, where changes are available.
function TurnChanges({ fold, files, turn, reply, collapsible }: { fold: string; files: readonly TurnFile[]; turn: TurnItem; reply: { text: string } | null; collapsible: boolean }) {
  const [showAll, setShowAll] = useDisclosure(`changes:${fold}`)
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
              <button key={file.path} type="button" className="chat-changes-file" data-file-path={file.path} title={file.path} onClick={() => surface.changes ? surface.showFileChange(file.path) : folds.reveal(collapsible ? fold : null, file.path)}>
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
        {reply && <MessageTime at={turn.at} />}
        <span className="chat-turn-summary-static" data-state={turn.state}>{turnText(turn)}</span>
        <ForkButton item={turn} />
      </div>
    </div>
  )
}

// `fresh` is a block that arrived while the chat was open: it enters with a motion.
function Block({ conversationId, block, task, replies, fresh }: { conversationId: string; block: ChatBlock; task: boolean; replies: ReadonlyMap<string, number>; fresh?: boolean }) {
  const entering = fresh || undefined
  if (block.kind === 'tools') return <ChatCopyRegion text={block.tools.map(copyTextForItem).join('\n\n')}><div className="chat-entry" data-fresh={entering}><ChatToolRun tools={block.tools} /></div></ChatCopyRegion>
  if (block.kind === 'agents') return <ChatCopyRegion text={block.tools.map(copyTextForItem).join('\n\n')}><div className="chat-entry" data-fresh={entering}><ChatSubagents tools={block.tools} /></div></ChatCopyRegion>
  if (block.kind === 'edits') return <ChatCopyRegion text={block.tools.map(copyTextForItem).join('\n\n')}><div className="chat-entry" data-fresh={entering}><ChatEditsCard path={block.path} tools={block.tools} /></div></ChatCopyRegion>
  if (block.kind === 'changes') return <ChatCopyRegion text={block.files.map((file) => `${file.path} +${file.added} −${file.removed}`).join('\n')}><div className="chat-entry" data-fresh={entering}><TurnChanges fold={block.fold} files={block.files} turn={block.turn} reply={block.reply} collapsible={block.collapsible} /></div></ChatCopyRegion>
  if (block.kind === 'fold') return <TurnFold foldKey={block.key} conversationId={conversationId} turn={block.turn} blocks={block.blocks} task={task} replies={replies} steps={block.steps} workMs={block.workMs} />
  const { entry } = block
  const merged = useContext(MergedTurns)
  if (entry.kind === 'item' && entry.item.kind === 'turn' && merged.has(block.key)) return null
  return (
    <ChatCopyRegion text={entry.kind === 'item' ? copyTextForItem(entry.item) : ''}>
    <div className="chat-entry" data-user={isUserEntry(entry) || undefined} data-entry-key={block.key} data-fresh={entering}>
      {entry.kind === 'stage' ? <StageDivider stage={entry.stage} task={task} />
        : <Item conversationId={conversationId} item={entry.item} completedAt={replies.get(block.key)} blockKey={block.key} />}
    </div>
    </ChatCopyRegion>
  )
}

// A conversation whose latest stage runs in chat mode: every stage in order, then the composer.
// What it does beyond itself comes from the surface it is shown on: a free conversation's own
// unless another is given, as a task's chat does.
export function ConversationChat({ conversation, surface, onHandoff }: { conversation: Conversation; surface?: ChatSurface; onHandoff?: () => void }) {
  const { id } = conversation
  const initialMessage = useInitialMessages((messages) => messages[id])
  const width = usePreferences((s) => s.chatWidth)
  const fontSize = usePreferences((s) => s.chatFontSize)
  const font = usePreferences((s) => s.chatFont)
  const fontFamily = usePreferences((s) => s.chatFontFamily)
  // A family picked from those installed goes in as a token, which the stylesheet puts first.
  const view = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = view.current
    if (!element) return
    if (font === 'custom' && fontFamily) element.style.setProperty('--chat-font-custom', cssFontFamily(fontFamily))
    else element.style.removeProperty('--chat-font-custom')
  }, [font, fontFamily])
  const forkSupported = useCore((s) => s.rpc?.features.includes('conversation-fork') ?? false)
  const fork = useCallback((item: ChatItem) => void forkConversation(conversation.id, item), [conversation.id])
  const own = useMemo(() => conversationSurface(conversation, onHandoff ?? null, forkSupported ? fork : null), [conversation, onHandoff, forkSupported, fork])
  const shown = surface ?? own
  const rpc = useCore((s) => s.rpc)
  const page = useChat((s) => s[id])
  const [stages, setStages] = useState<ConversationStage[]>([])
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [away, setAway] = useState(false)
  // Every block shown so far, so one that arrives while the chat is open can enter with a motion;
  // older history loaded on request is simply there.
  const seen = useRef<Set<string> | null>(null)
  // Once a block has entered it stays marked: dropping the mark mid-motion would cut it short.
  const entered = useRef(new Set<string>())
  const olderLoaded = useRef(false)
  useEffect(() => {
    seen.current = null
    entered.current = new Set()
  }, [id])

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

  // A new stage starts with a new session; earlier stages do not change.
  useEffect(() => {
    if (!rpc) return
    let current = true
    rpc.call('conversations.stages', { id }).then(
      (nextStages) => {
        if (current) setStages(nextStages)
      },
      () => {}
    )
    return () => {
      current = false
    }
  }, [rpc, id, conversation.sessionId])

  const items = page?.items ?? NO_ITEMS
  useEffect(() => acknowledgeInitialMessage(id, items), [id, items])
  const entries = useMemo(() => {
    // A plan shows with its approval; the call's own card would only repeat it.
    const plans = new Set(items.flatMap((item) =>
      item.kind === 'approval' && isPlanApproval(item) && item.toolItemId ? [itemKey({ stageId: item.stageId, id: item.toolItemId })] : []))
    // A turn the usage limit stopped says so on a line of its own, after it: the turn's error and
    // the words the CLI ended it with would only repeat that.
    const limited = new Set(items.flatMap((item) =>
      item.kind === 'usageLimit' ? [itemKey({ stageId: item.stageId, id: item.id.replace(/^limit:/, 'turn:') })] : []))
    const limitWords = new Set(items.flatMap((item) => (item.kind === 'usageLimit' && item.message ? [`${item.stageId}\n${item.message.trim()}`] : [])))
    return timeline(stages, items).flatMap((entry): TimelineEntry[] => {
      if (entry.kind !== 'item') return [entry]
      const { item } = entry
      if (plans.has(itemKey(item))) return []
      if (item.kind === 'assistant' && limitWords.has(`${item.stageId}\n${item.text.trim()}`)) return []
      return item.kind === 'turn' && limited.has(itemKey(item)) ? [{ kind: 'item', item: { ...item, error: null } }] : [entry]
    })
  }, [stages, items])
  const foldTurns = usePreferences((s) => s.foldTurns)
  const blocks = useMemo(() => chatBlocks(entries, { foldTurns }), [entries, foldTurns])
  for (const key of freshKeys(seen.current, blocks.map((block) => block.key), olderLoaded.current)) entered.current.add(key)
  useEffect(() => {
    if (!page) return
    seen.current = new Set([...(seen.current ?? []), ...blocks.map((block) => block.key)])
    olderLoaded.current = false
  }, [page, blocks])
  const replies = useMemo(() => {
    const found = finalReplies(entries)
    // A turn with a change card moves these actions below that card.
    for (const block of blocks) {
      if (block.kind === 'changes' && block.reply) found.delete(block.reply.key)
    }
    return found
  }, [entries, blocks])
  // A turn's own line, when it follows the reply it closes and that reply keeps its actions, joins
  // that line instead of standing under it.
  const { endings, mergedTurns } = useMemo(() => {
    const endings = new Map<string, TurnItem>()
    const mergedTurns = new Set<string>()
    blocks.forEach((block, index) => {
      const previous = blocks[index - 1]
      const turn = block.kind === 'entry' && block.entry.kind === 'item' && block.entry.item.kind === 'turn' ? block.entry.item : null
      if (turn && previous && replies.has(previous.key)) {
        endings.set(previous.key, turn)
        mergedTurns.add(block.key)
      }
    })
    return { endings, mergedTurns }
  }, [blocks, replies])
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
    if (entry.kind !== 'item' || entry.item.kind !== 'user') return [{ key: block.key, text: '' }]
    const { quotes, body } = parseQuotes(entry.item.text)
    return [{ key: block.key, text: `${quotes.length ? `（引用 ${quotes.length} 段）` : ''}${body}` }]
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

  // The browser's live view opens beside the conversation when the agent first uses it, once per
  // conversation; a call still running keeps old history from opening it on a revisit.
  const browserCall = useMemo(() => firstBrowserCall(items), [items])
  const shownBrowser = useRef<string | null>(null)
  const showBrowser = shown.showBrowser
  useEffect(() => {
    if (!browserCall || shownBrowser.current === conversation.id || !shouldOpenBrowser()) return
    shownBrowser.current = conversation.id
    showBrowser()
  }, [browserCall, conversation.id, showBrowser])

  // The working line comes and goes with the turn, below the entries: pinned to the end, the list
  // follows it too, or the line (and the relay's dot that runs to it) sits just under the edge.
  const turnState = conversation.chat?.turn
  useLayoutEffect(() => {
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [entries, turnState])

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
  const jumpTo = useCallback((key: string) => jump(key), [])
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
      olderLoaded.current = true
      prependChatPage(id, older)
    }
  }

  const roots = useMemo(
    () => (conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]),
    [conversation.projectPaths, conversation.workspacePath]
  )
  const shorten = useMemo(() => pathShortener(roots), [roots])
  // A reply's shell blocks run in this conversation's own terminal tab, in its folder.
  const runScope = useMemo(() => ({ key: conversation.id, cwd: conversation.workspacePath }), [conversation.id, conversation.workspacePath])
  const turn = conversation.sessionId ? (conversation.chat?.turn ?? null) : null
  // What kind of step the turn is at, and what it has out in the background (subagents, and
  // commands run there), for the working line; the step itself shows in the conversation, just above it.
  const running = useMemo(() => {
    const tools = items.filter((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool' && item.status === 'running')
    const subagents = tools.filter((tool) => isSubagent(tool.name)).length
    const commands = tools.filter((tool) => tool.background && !isSubagent(tool.name)).length
    const last = items.at(-1)
    const phase: WorkingPhase = turn === 'awaiting' ? 'asking'
      : tools.some((tool) => !isSubagent(tool.name) && !tool.background) ? 'tools'
      : last?.kind === 'reasoning' && last.streaming ? 'thinking'
        : last?.kind === 'assistant' && last.streaming ? 'replying'
          : tools.length > 0 ? 'waiting' : 'working'
    return { phase, background: { subagents, commands } }
  }, [items, turn])
  // The model as the stage runs it, or as the next stage would start; by its label where the agent gives one.
  const modelId = state?.model ?? conversation.chatOptions?.model ?? null
  // The effort the same way; left out where the agent runs its default without saying which.
  const effort = state?.effort ?? conversation.chatOptions?.effort ?? null
  const agentInfo = useMemo(
    () => ({ agent: conversation.agent, model: modelId ? (state?.models.find((each) => each.id === modelId)?.label ?? modelId) : null, effort }),
    [conversation.agent, modelId, state?.models, effort]
  )
  // A turn runs from the message that set it going.
  const since = useMemo(() => items.findLast((item) => item.kind === 'user')?.at ?? null, [items])
  const beginRelay = useMessageRelay(view, list, items, id)
  const lastUserKey = sent.at(-1)?.key
  const fileScope = useMemo(() => ({ conversationId: id, inspector: shown.inspector, roots }), [id, shown.inspector, roots])
  const contextMenu = useChatContextMenu(list, fileScope)
  return (
    <ChatSurfaceContext.Provider value={shown}>
    <ChatAgent.Provider value={agentInfo}>
    <ChatPaths.Provider value={shorten}>
    <ChatRoots.Provider value={roots}>
    <ChatFilesContext.Provider value={fileScope}>
    <ChatRunScope.Provider value={runScope}>
    <Thoughts.Provider value={thoughts}>
    <Endings.Provider value={endings}>
    <MergedTurns.Provider value={mergedTurns}>
    <ChatDisclosureScope.Provider value={id}>
    <Folds.Provider value={folds}>
    <TodoHistory.Provider value={todoHistory}>
    <JumpToEntry.Provider value={jumpTo}>
    <ChatMessageRelay.Provider value={beginRelay}>
    <div className="chat-view" ref={view} data-width={width} data-font-size={fontSize} data-font={font === 'custom' && !fontFamily ? 'system' : font}>
      <div
        className="chat-list"
        ref={list}
        onContextMenu={contextMenu.onContextMenu}
        onKeyDown={contextMenu.onKeyDown}
        onPointerDownCapture={contextMenu.onPointerDown}
        onScroll={(event) => {
          const element = event.currentTarget
          const below = element.scrollHeight - element.scrollTop - element.clientHeight
          pinned.current = below < PINNED_SLACK
          setAway(below > AWAY_SLACK)
        }}
      >
        {page?.before && <button type="button" className="link-button chat-older" onClick={() => void loadOlder()}>加载更早的聊天记录</button>}
        {!page && !initialMessage && <ChatSkeleton />}
        {blocks.map((block, index) => {
          const next = blocks[index + 1]
          const sentAt = userAt(block)
          const entering = entered.current.has(block.key)
          // The head under the latest message is the running turn's, while it runs.
          const live = (turn === 'running' || turn === 'awaiting') && block.key === lastUserKey ? turn : null
          // A message's answer opens with the agent's head, under the message: as soon as it is sent
          // and the turn runs, before the agent has said anything, and kept in place once it does.
          const head = sentAt !== null && (next ? userAt(next) === null : live !== null)
          return (
            <Fragment key={block.key}>
              <Block conversationId={id} block={block} task={Boolean(conversation.taskId)} replies={replies} fresh={entering} />
              {head && <div className="chat-entry" data-fresh={entering || undefined}><TurnHead at={sentAt} messageKey={block.key} live={live} /></div>}
            </Fragment>
          )
        })}
        {initialMessage && !items.some((item) => item.kind === 'user' && item.id === `u:${initialMessage.ref}`) && (
          <InitialMessageEntry id={id} agent={conversation.agent} message={initialMessage} />
        )}
        {(turn === 'running' || turn === 'awaiting') && (
          <ChatWorking
            phase={running.phase}
            tokens={state?.turnUsage?.output ?? null}
            background={running.background}
            since={since}
          />
        )}
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
      <ChatQuotePicker conversationId={id} list={list} enabled={!contextMenu.open} />
      {contextMenu.menu}
    </div>
    </ChatMessageRelay.Provider>
    </JumpToEntry.Provider>
    </TodoHistory.Provider>
    </Folds.Provider>
    </ChatDisclosureScope.Provider>
    </MergedTurns.Provider>
    </Endings.Provider>
    </Thoughts.Provider>
    </ChatRunScope.Provider>
    </ChatFilesContext.Provider>
    </ChatRoots.Provider>
    </ChatPaths.Provider>
    </ChatAgent.Provider>
    </ChatSurfaceContext.Provider>
  )
}
