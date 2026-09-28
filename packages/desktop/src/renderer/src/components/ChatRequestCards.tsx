import { useContext, useState } from 'react'
import type { ChatDecision, ChatItem } from '@kando/protocol'
import { perform } from '../core-store'
import { ChatPaths, toolLabel } from './ChatToolCard'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>
type QuestionItem = Extract<ChatItem, { kind: 'question' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = ApprovalItem | QuestionItem

const DECISION_LABEL: Record<ChatDecision, string> = { allow: '允许', allowForSession: '本会话都允许', deny: '拒绝' }
const RESOLUTION_TEXT: Record<NonNullable<ApprovalItem['resolution']>, string> = {
  allowed: '已允许',
  allowedForSession: '已允许，本会话不再询问',
  denied: '已拒绝',
  cancelled: '已取消'
}

function useResponder(conversationId: string, requestId: string) {
  const [busy, setBusy] = useState(false)
  const respond = async (decision: ChatDecision, extra: { message?: string; answers?: Record<string, string[]> } = {}) => {
    if (busy) return
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.respond', { id: conversationId, requestId, decision, ...extra }))
    setBusy(false)
  }
  return { busy, respond }
}

// Where a request sits in the conversation: one line, pointing down to its card while it waits,
// and saying how it went once answered. An answered question keeps its card, which shows the answer.
export function ChatRequestLine({ conversationId, item }: { conversationId: string; item: RequestItem }) {
  const shorten = useContext(ChatPaths)
  if (item.kind === 'question') {
    if (item.resolution !== null) return <ChatQuestionCard conversationId={conversationId} item={item} />
    return <div className="chat-request-line" data-waiting>agent 在问你：{item.questions[0]?.question ?? ''} · 在下方回答</div>
  }
  const what = <>{toolLabel(item.tool)} <span className="mono">{shorten(item.title)}</span></>
  return item.resolution === null
    ? <div className="chat-request-line" data-waiting>需要你确认：{what} · 在下方回答</div>
    : <div className="chat-request-line">{what} · {RESOLUTION_TEXT[item.resolution]}</div>
}

// A waiting approval, docked above the composer: what the agent wants to do and the answers it
// takes. The call's own card in the list has its diff; a command is repeated here in full, since
// that card shows only its first line.
export function ChatApprovalCard({ conversationId, item, tool }: { conversationId: string; item: ApprovalItem; tool: ToolItem | undefined }) {
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [reason, setReason] = useState('')
  const shorten = useContext(ChatPaths)
  const title = shorten(item.title)
  // Claude describes a file call by the file's name, which the title already has.
  const detail = item.detail && !title.includes(shorten(item.detail)) ? shorten(item.detail) : null
  return (
    <div className="chat-request" data-waiting>
      <div className="chat-request-title">
        需要你确认：{toolLabel(item.tool)} <span className="mono">{title}</span>
      </div>
      {detail && <p className="chat-request-detail muted">{detail}</p>}
      {tool?.input && <pre className="chat-tool-io">{tool.input}</pre>}
      <div className="chat-request-actions">
        <input
          className="input chat-request-reason"
          placeholder="拒绝的理由（可选，会告诉 agent）"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {item.decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            className={decision === 'deny' ? 'button ghost' : decision === 'allow' ? 'button primary' : 'button'}
            disabled={busy}
            onClick={() => void respond(decision, decision === 'deny' && reason.trim() ? { message: reason.trim() } : {})}
          >
            {DECISION_LABEL[decision]}
          </button>
        ))}
      </div>
    </div>
  )
}

// Interactive while it waits (docked above the composer), a record of the answer afterwards.
export function ChatQuestionCard({ conversationId, item }: { conversationId: string; item: QuestionItem }) {
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const waiting = item.resolution === null
  const toggle = (questionId: string, label: string, multiSelect: boolean) =>
    setChosen((current) => {
      const picked = current[questionId] ?? []
      const next = multiSelect ? (picked.includes(label) ? picked.filter((each) => each !== label) : [...picked, label]) : [label]
      return { ...current, [questionId]: next }
    })
  const complete = item.questions.every((question) => (chosen[question.id] ?? []).length > 0)
  return (
    <div className="chat-request" data-waiting={waiting || undefined}>
      {item.questions.map((question) => {
        const picked = waiting ? (chosen[question.id] ?? []) : (item.answers?.[question.id] ?? [])
        return (
          <div key={question.id} className="chat-question">
            {question.header && <div className="chat-question-header muted">{question.header}</div>}
            <div className="chat-request-title">{question.question}</div>
            <div className="chat-question-options" role={question.multiSelect ? 'group' : 'radiogroup'}>
              {question.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={picked.includes(option.label)}
                  className="chat-question-option"
                  disabled={!waiting || busy}
                  title={option.description ?? undefined}
                  onClick={() => toggle(question.id, option.label, question.multiSelect)}
                >
                  {option.label}
                  {option.description && <span className="muted"> · {option.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {waiting ? (
        <div className="chat-request-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => void respond('deny')}>不回答</button>
          <button type="button" className="button primary" disabled={busy || !complete} onClick={() => void respond('allow', { answers: chosen })}>回答</button>
        </div>
      ) : (
        <div className="chat-request-resolution muted">{item.resolution === 'answered' ? '已回答' : '没有回答'}</div>
      )}
    </div>
  )
}
