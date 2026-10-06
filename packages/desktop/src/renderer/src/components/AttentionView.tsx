import { useState } from 'react'
import type { ChatDecision, ConversationRequest } from '@kando/protocol'
import { quickApproval, type ActionableItem, type ActionableReason } from '../attention'
import { toolLabel } from '../chat-tools'
import { openAttentionItem, perform, refreshAttentionSummaries, setAttentionOpen, useActionableItems, useCore } from '../core-store'
import { AGENT_LABEL, chatDayAndTime } from '../labels'
import { projectNames } from './ProjectPicker'
import { CloseIcon } from './icons'

const REASON_LABEL: Record<ActionableReason, string> = {
  awaiting: '等待确认／回答', crashed: '异常退出', review: '待验收', reply: '等你回复'
}
const ACTION_LABEL: Record<ActionableReason, string> = {
  awaiting: '去处理', crashed: '查看异常', review: '检查变更', reply: '继续对话'
}

// What the agent asks, in a line: the tool and its command or path, or the question.
function AttentionRequest({ request }: { request: ConversationRequest }) {
  return (
    <div className="attention-request">
      <span className="attention-request-tool">{request.kind === 'question' ? '提问' : toolLabel(request.tool ?? '')}</span>
      <code title={request.title}>{request.title}</code>
      {request.open > 1 && <span className="attention-request-more">还有 {request.open - 1} 项</span>}
    </div>
  )
}

function AttentionRow({ item }: { item: ActionableItem }) {
  const [busy, setBusy] = useState(false)
  const reason = item.primaryReason
  const noChat = !item.conversationId
  const action = noChat ? '查看任务' : ACTION_LABEL[reason]
  const { request, conversationId } = item
  const quick = conversationId && quickApproval(request) ? request : null
  // Allowed this once, nothing remembered: a rule is chosen in the chat, where its reach is shown.
  const answer = async (decision: ChatDecision) => {
    if (!quick || !conversationId) return
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.respond', { id: conversationId, requestId: quick.requestId, decision }))
    setBusy(false)
  }
  return (
    <li className="attention-row">
      <div className="attention-row-content">
        <div className="attention-row-heading">
          <h3>{item.title}</h3>
          {item.reasons.map((each) => (
            <span key={each} className="attention-reason" data-reason={each}>
              {each === 'reply' && noChat ? '需要继续处理' : REASON_LABEL[each]}
            </span>
          ))}
        </div>
        <div className="attention-row-meta">
          <span>{item.target.kind === 'task' ? '任务' : '聊天'}</span>
          {item.agent && <span>{AGENT_LABEL[item.agent]}</span>}
          <span className="attention-project" title={item.projectPaths.join('\n')}>{projectNames(item.projectPaths)}</span>
          <time dateTime={new Date(item.updatedAt).toISOString()}>更新于 {chatDayAndTime(item.updatedAt)}</time>
        </div>
        {request && <AttentionRequest request={request} />}
      </div>
      <div className="attention-row-actions">
        <button type="button" className="button ghost" aria-label={`${action}：${item.title}`} onClick={() => openAttentionItem(item)}>
          {action}
        </button>
        {quick && (
          <>
            <button type="button" className="button" disabled={busy} aria-label={`拒绝：${quick.title}`} onClick={() => void answer('deny')}>拒绝</button>
            <button type="button" className="button primary" disabled={busy} aria-label={`允许一次：${quick.title}`}
              data-tooltip="只允许这一次，不记规则" onClick={() => void answer('allow')}>允许</button>
          </>
        )}
      </div>
    </li>
  )
}

export function AttentionView() {
  const items = useActionableItems()
  const connected = useCore((s) => s.connection === 'connected')
  const loading = useCore((s) => s.attentionSummaryLoading)
  const mode = useCore((s) => s.attentionSummaryMode)
  const error = useCore((s) => s.attentionSummaryError)
  const emptyConfirmed = connected && !loading && !error && mode !== null
  return (
    <section className="worktrees-page attention-page" aria-label="需要我处理">
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>需要我处理</h2>
          <p className="muted" role="status">{!emptyConfirmed || mode === 'limited' ? '已知 ' : ''}{items.length} 项需要处理 · 确认、回复、查看异常和验收</p>
        </div>
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => setAttentionOpen(false)}>
          <CloseIcon />
        </button>
      </header>
      {!connected && <p className="attention-notice muted" role="status">尚未连接到 core，事项尚未更新。{items.length > 0 ? '以下为最近收到的信息。' : '连接后将显示待处理事项。'}</p>}
      {connected && loading && <p className="attention-notice muted" role="status">正在读取待处理事项…</p>}
      {mode === 'limited' && <p className="attention-notice muted">当前 core 的任务聊天详情不完整</p>}
      {error && (
        <div className="attention-notice attention-error" role="alert">
          <div>聊天摘要加载失败，事项可能不完整。<span className="muted">{error}</span></div>
          <button type="button" className="button ghost" disabled={!connected || loading} onClick={() => void refreshAttentionSummaries()}>重试</button>
        </div>
      )}
      {items.length > 0 ? (
        <ul className="attention-list">
          {items.map((item) => <AttentionRow key={`${item.target.kind}:${item.target.id}`} item={item} />)}
        </ul>
      ) : emptyConfirmed ? (
        <p className="attention-empty muted">暂时没有需要你处理的事项</p>
      ) : null}
    </section>
  )
}
