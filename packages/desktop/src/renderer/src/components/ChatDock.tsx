import { isPlanApproval, type ChatItem, type Conversation } from '@kando/protocol'
import { itemKey } from '../chat-state'
import { useChatSurface } from './chat-surface'
import { ChatComposer } from './ChatComposer'
import { ChatMessageList, type SentMessage } from './ChatMessageList'
import { ChatPlanCard } from './ChatPlan'
import { ChatApprovalCard, ChatQuestionCard, type RequestItem } from './ChatRequestCards'
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
  return (
    <div className="chat-dock">
      <div className="chat-dock-header">
        {running && state && <ChatTodosChip todos={state.todos} />}
        {inspectable && <ChangesChip conversation={conversation} finishedCalls={finishedCalls} />}
        <span className="chat-dock-spacer" />
        <ChatMessageList messages={sent} onJump={onJump} />
        <button type="button" className="tool-button" aria-label="上一条消息" data-tooltip="上一条消息" onClick={onPrevious}>
          <ArrowUpIcon />
        </button>
      </div>
      {running && pending.length > 0 && (
        <div className="chat-dock-requests">
          {pending.map((item) =>
            item.kind === 'question'
              ? <ChatQuestionCard key={itemKey(item)} conversationId={conversation.id} item={item} />
              : isPlanApproval(item)
                ? <ChatPlanCard key={itemKey(item)} conversationId={conversation.id} item={item} />
                : <ChatApprovalCard key={itemKey(item)} conversationId={conversation.id} item={item} tool={item.toolItemId ? tools.get(item.toolItemId) : undefined} />
          )}
        </div>
      )}
      <ChatComposer conversation={conversation} state={state} />
    </div>
  )
}
