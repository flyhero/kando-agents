import { useContext, useState } from 'react'
import { isPlanApproval, type ChatItem, type Conversation } from '@kando/protocol'
import { itemKey } from '../chat-state'
import { toolLabel } from '../chat-tools'
import { useChatSurface } from './chat-surface'
import { ChatComposer } from './ChatComposer'
import { ChatMessageList, type SentMessage } from './ChatMessageList'
import { ChatPlanCard } from './ChatPlan'
import { ChatProjects } from './ChatProjects'
import { ChatApprovalCard, ChatQuestionCard, type RequestItem } from './ChatRequestCards'
import { ChatPaths } from './ChatToolCard'
import { ChatTodosChip } from './ChatTodos'
import { ArrowUpIcon } from './icons'
import { lineTotals, useChangedFiles } from './Inspector'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type StateItem = Extract<ChatItem, { kind: 'state' }>

// What the project holds uncommitted, read again whenever a call finishes; a click opens the
// inspector with the files.
function ChangesChip({ conversation, finishedCalls }: { conversation: Conversation; finishedCalls: number }) {
  const surface = useChatSurface()
  const files = useChangedFiles(surface.changes, conversation.updatedAt, finishedCalls) ?? []
  if (files.length === 0) return null
  // New and binary files have no line counts; a row of only those would read +0 −0.
  const counted = files.filter((file) => file.additions !== null && file.deletions !== null)
  return (
    <button
      type="button"
      className="chat-changes"
      data-tooltip={surface.changesHint}
      onClick={surface.showChanges}
    >
      {files.length} 个文件改动{counted.length > 0 && <span className="mono"> {lineTotals(counted)}</span>}
    </button>
  )
}

// What a waiting request is called on its tab: the call it asks about, or what it asks.
function RequestTabLabel({ item }: { item: RequestItem }) {
  const shorten = useContext(ChatPaths)
  if (item.kind === 'question') return <>提问{item.questions[0]?.header ? ` · ${item.questions[0].header}` : ''}</>
  if (isPlanApproval(item)) return <>计划</>
  return <>{toolLabel(item.tool)} <span className="mono">{shorten(item.title)}</span></>
}

// The requests waiting on the user, in the composer's place: one at a time, behind a tab each when
// there are several, so the newest cannot push the rest out of reach.
function PendingRequests({ conversation, pending, tools }: { conversation: Conversation; pending: readonly RequestItem[]; tools: ReadonlyMap<string, ToolItem> }) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const shown = pending.find((item) => itemKey(item) === activeKey) ?? pending[0]
  if (!shown) return null
  const at = pending.indexOf(shown)
  return (
    <div className="chat-intervention" data-pending-hotkey-scope>
      {pending.length > 1 && (
        <div className="chat-intervention-tabs" role="tablist" aria-label="等你处理的请求">
          {pending.map((item) => (
            <button
              key={itemKey(item)}
              type="button"
              role="tab"
              aria-selected={item === shown}
              className="chat-intervention-tab"
              onClick={() => setActiveKey(itemKey(item))}
            >
              <RequestTabLabel item={item} />
            </button>
          ))}
          <span className="chat-intervention-count">{at + 1} / {pending.length}</span>
        </div>
      )}
      {shown.kind === 'question'
        ? <ChatQuestionCard key={itemKey(shown)} conversationId={conversation.id} item={shown} />
        : isPlanApproval(shown)
          ? <ChatPlanCard key={itemKey(shown)} conversationId={conversation.id} item={shown} />
          : <ChatApprovalCard key={itemKey(shown)} conversationId={conversation.id} item={shown} tool={shown.toolItemId ? tools.get(shown.toolItemId) : undefined} />}
    </div>
  )
}

// Everything that waits on the user sits here, above the composer, so it cannot scroll out of view.
export function ChatDock({ conversation, state, pending, tools, finishedCalls, onPrevious, sent, onJump }: {
  conversation: Conversation
  // The running stage's state; null for an older core or before the stage reports one.
  state: StateItem | null
  pending: readonly RequestItem[]
  tools: ReadonlyMap<string, ToolItem>
  finishedCalls: number
  onPrevious: () => void
  sent: readonly SentMessage[]
  onJump: (key: string) => void
}) {
  const inspectable = useChatSurface().changes !== null
  const running = conversation.sessionId !== null
  const waiting = running && pending.length > 0
  return (
    <div className="chat-dock">
      <div className="chat-dock-header">
        <ChatProjects conversation={conversation} />
        {running && state && <ChatTodosChip todos={state.todos} />}
        {inspectable && <ChangesChip conversation={conversation} finishedCalls={finishedCalls} />}
        <span className="chat-dock-spacer" />
        <ChatMessageList messages={sent} onJump={onJump} />
        <button type="button" className="tool-button" aria-label="上一条消息" data-tooltip="上一条消息" onClick={onPrevious}>
          <ArrowUpIcon />
        </button>
      </div>
      {waiting && <PendingRequests conversation={conversation} pending={pending} tools={tools} />}
      {/* The composer stays mounted while a request takes its place, so a draft is not lost. */}
      <div className="chat-dock-composer" hidden={waiting}>
        <ChatComposer conversation={conversation} state={state} />
      </div>
    </div>
  )
}
