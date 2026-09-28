import type { ChatItem, Conversation } from '@kando/protocol'
import { showConversationChanges, useChatOptionsSupported } from '../core-store'
import { isPlan, itemKey } from '../chat-state'
import { ChatComposer } from './ChatComposer'
import { ChatOptionsBar } from './ChatOptionsBar'
import { ChatPlanCard } from './ChatPlan'
import { ChatApprovalCard, ChatQuestionCard, type RequestItem } from './ChatRequestCards'
import { ChatTodosChip } from './ChatTodos'
import { useFolderChanges } from './ConversationInspector'
import { ArrowUpIcon } from './icons'
import { lineTotals } from './Inspector'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type StateItem = Extract<ChatItem, { kind: 'state' }>

// What the project holds uncommitted, read again whenever a call finishes; a click opens the
// inspector with the files. The folders are the user's too, so their own edits count here.
function ChangesChip({ conversation, finishedCalls }: { conversation: Conversation; finishedCalls: number }) {
  const changes = useFolderChanges(conversation.id, conversation.updatedAt, finishedCalls)
  const files = changes?.flatMap((folder) => folder.files) ?? []
  if (files.length === 0) return null
  // New and binary files have no line counts; a row of only those would read +0 −0.
  const counted = files.filter((file) => file.additions !== null && file.deletions !== null)
  return (
    <button
      type="button"
      className="chat-changes"
      data-tooltip="项目里还没提交的改动，也可能有你自己的；点开检查器看"
      onClick={showConversationChanges}
    >
      {files.length} 个文件改动{counted.length > 0 && <span className="mono"> {lineTotals(counted)}</span>}
    </button>
  )
}

// Everything that waits on the user sits here, above the composer, so it cannot scroll out of view.
export function ChatDock({ conversation, state, pending, tools, finishedCalls, onPrevious }: {
  conversation: Conversation
  // The running stage's state; null for an older core or before the stage reports one.
  state: StateItem | null
  pending: readonly RequestItem[]
  tools: ReadonlyMap<string, ToolItem>
  finishedCalls: number
  onPrevious: () => void
}) {
  const inspectable = conversation.projectPaths.length > 0
  const running = conversation.sessionId !== null
  const optionsSupported = useChatOptionsSupported()
  return (
    <div className="chat-dock">
      <div className="chat-dock-header">
        {running && state && <ChatTodosChip todos={state.todos} />}
        {inspectable && <ChangesChip conversation={conversation} finishedCalls={finishedCalls} />}
        <span className="chat-dock-spacer" />
        <button type="button" className="tool-button" aria-label="上一条消息" data-tooltip="上一条消息" onClick={onPrevious}>
          <ArrowUpIcon />
        </button>
      </div>
      {running && pending.length > 0 && (
        <div className="chat-dock-requests">
          {pending.map((item) =>
            item.kind === 'question'
              ? <ChatQuestionCard key={itemKey(item)} conversationId={conversation.id} item={item} />
              : isPlan(item)
                ? <ChatPlanCard key={itemKey(item)} conversationId={conversation.id} item={item} />
                : <ChatApprovalCard key={itemKey(item)} conversationId={conversation.id} item={item} tool={item.toolItemId ? tools.get(item.toolItemId) : undefined} />
          )}
        </div>
      )}
      <ChatComposer conversation={conversation} queued={running ? (state?.queued ?? null) : null} />
      {optionsSupported && state && <ChatOptionsBar conversation={conversation} state={state} />}
    </div>
  )
}
