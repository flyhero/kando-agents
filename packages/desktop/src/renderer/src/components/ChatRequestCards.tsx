import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatDecision, ChatItem, ChatQuestion } from '@kando/protocol'
import { questionAnswers } from '../chat-state'
import { perform } from '../core-store'
import { toolLabel } from '../chat-tools'
import { ChatPaths } from './ChatToolCard'
import { CheckIcon, PencilIcon } from './icons'

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

export function useResponder(conversationId: string, requestId: string) {
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
// and saying how it went once answered. An answered question leaves what was asked and answered.
export function ChatRequestLine({ item }: { item: RequestItem }) {
  const shorten = useContext(ChatPaths)
  if (item.kind === 'question') {
    if (item.resolution !== null) return <ChatQuestionReceipt item={item} />
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
// What a question is answered with: the options picked, then what was typed, if anything.
function answerOf(picked: readonly string[], typed: string | undefined): string[] {
  const text = typed?.trim()
  return text ? [...picked, text] : [...picked]
}

// Claude marks the option it would pick in the label itself; the answer keeps the label as it is.
const RECOMMENDED = /\s*\(recommended\)\s*$/i

function OptionLabel({ label }: { label: string }) {
  const recommended = RECOMMENDED.test(label)
  return (
    <span className="chat-ask-label">
      {recommended ? label.replace(RECOMMENDED, '') : label}
      {recommended && <span className="chat-ask-recommended">推荐</span>}
    </span>
  )
}


// A question waiting in the dock, one at a time behind a tab per question: each option a row with
// its number, which becomes a check when picked, and a last row to type an answer of one's own.
// Picking one of a single choice moves on; the number keys pick, Enter goes on from what is typed.
export function ChatQuestionCard({ conversationId, item }: { conversationId: string; item: QuestionItem }) {
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const { questions } = item
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [typing, setTyping] = useState<Record<string, boolean>>({})
  const card = useRef<HTMLDivElement>(null)

  // The card takes the keys when it comes up, unless the user is writing something; and it keeps
  // them from one question to the next.
  useEffect(() => {
    const active = document.activeElement
    const writing = active instanceof HTMLTextAreaElement && active.value !== ''
    const within = active === document.body || (active !== null && card.current?.contains(active))
    if (!writing && (within || active instanceof HTMLTextAreaElement)) {
      card.current?.querySelector<HTMLElement>('[data-option]')?.focus()
    }
  }, [index])

  const question = questions[index]
  if (!question) return null
  const answer = (each: ChatQuestion) => answerOf(picked[each.id] ?? [], typing[each.id] ? typed[each.id] : undefined)
  const answered = (each: ChatQuestion) => answer(each).length > 0
  const last = index === questions.length - 1
  const unanswered = questions.filter((each) => !answered(each)).length
  const submit = () => void respond('allow', { answers: Object.fromEntries(questions.map((each) => [each.id, answer(each)])) })
  const chosen = picked[question.id] ?? []

  const choose = (label: string) => {
    if (question.multiSelect) {
      setPicked({ ...picked, [question.id]: chosen.includes(label) ? chosen.filter((each) => each !== label) : [...chosen, label] })
      return
    }
    const choosing = !chosen.includes(label)
    setPicked({ ...picked, [question.id]: choosing ? [label] : [] })
    setTyping({ ...typing, [question.id]: false })
    if (choosing && !last) setIndex(index + 1)
  }
  const toggleTyping = () => {
    const open = !typing[question.id]
    setTyping({ ...typing, [question.id]: open })
    // One answer to a single choice: typing one's own replaces the option picked.
    if (open && !question.multiSelect) setPicked({ ...picked, [question.id]: [] })
  }
  const goOn = () => {
    if (!answered(question)) return
    if (!last) setIndex(index + 1)
    else if (unanswered === 0) submit()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        goOn()
      }
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const rows = [...(card.current?.querySelectorAll<HTMLElement>('[data-option]') ?? [])]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = rows.findIndex((row) => row === document.activeElement)
      rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
    } else if (/^[1-9]$/.test(event.key)) {
      const option = question.options[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        choose(option.label)
      }
    } else if (event.key === '0') {
      event.preventDefault()
      toggleTyping()
    }
  }

  return (
    <div className="chat-request chat-ask" data-waiting ref={card} onKeyDown={onKeyDown}>
      <div className="chat-ask-head">
        {questions.length > 1 ? (
          <div className="chat-ask-tabs" role="tablist" aria-label="问题">
            {questions.map((each, at) => (
              <button
                key={each.id}
                type="button"
                role="tab"
                aria-selected={at === index}
                className="chat-ask-tab"
                onClick={() => setIndex(at)}
              >
                {answered(each) && <CheckIcon />}
                {each.header || `问题 ${at + 1}`}
              </button>
            ))}
          </div>
        ) : (
          question.header && <span className="chat-ask-chip">{question.header}</span>
        )}
        <span className="chat-dock-spacer" />
        {questions.length > 1 && <span className="chat-ask-count muted">{index + 1}/{questions.length}</span>}
      </div>
      <div className="chat-ask-question" id={`${item.requestId}-question`}>
        {question.question}
        {question.multiSelect && <span className="chat-ask-hint muted">可多选</span>}
      </div>
      <div
        className="chat-ask-options"
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-labelledby={`${item.requestId}-question`}
      >
        {question.options.map((option, at) => {
          const on = chosen.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              data-option
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              className="chat-ask-option"
              disabled={busy}
              onClick={() => choose(option.label)}
            >
              <span className="chat-ask-key" data-multi={question.multiSelect || undefined}>{on ? <CheckIcon /> : at < 9 ? at + 1 : ''}</span>
              <span className="chat-ask-text">
                <OptionLabel label={option.label} />
                {option.description && <span className="chat-ask-description">{option.description}</span>}
              </span>
            </button>
          )
        })}
        <div className="chat-ask-other" data-open={typing[question.id] || undefined}>
          <button
            type="button"
            data-option
            className="chat-ask-option"
            aria-expanded={Boolean(typing[question.id])}
            disabled={busy}
            onClick={toggleTyping}
          >
            <span className="chat-ask-key" data-multi={question.multiSelect || undefined}><PencilIcon /></span>
            <span className="chat-ask-text"><span className="chat-ask-label">其他，自己填写</span></span>
          </button>
          {typing[question.id] && (
            <input
              className="input chat-ask-input"
              autoFocus
              value={typed[question.id] ?? ''}
              placeholder="写下你的回答，Enter 继续"
              aria-label={`${question.question} 的其他回答`}
              disabled={busy}
              onChange={(event) => setTyped({ ...typed, [question.id]: event.target.value })}
            />
          )}
        </div>
      </div>
      <div className="chat-request-actions">
        <button type="button" className="button ghost" disabled={busy} onClick={() => void respond('deny')}>不回答</button>
        <span className="chat-dock-spacer" />
        {index > 0 && <button type="button" className="button ghost" disabled={busy} onClick={() => setIndex(index - 1)}>上一个</button>}
        {last ? (
          <button
            type="button"
            className="button primary"
            disabled={busy || unanswered > 0}
            title={unanswered > 0 ? `还有 ${unanswered} 个问题没回答` : undefined}
            onClick={submit}
          >
            提交
          </button>
        ) : (
          <button type="button" className="button primary" disabled={busy || !answered(question)} onClick={goOn}>下一个</button>
        )}
      </div>
    </div>
  )
}

// What was asked and what the user said, left in the conversation once the question is settled.
function ChatQuestionReceipt({ item }: { item: QuestionItem }) {
  const settled = item.resolution === 'answered'
  const count = item.questions.length
  return (
    <div className="chat-ask-receipt">
      <div className="chat-ask-receipt-title muted">
        {settled ? (count > 1 ? `回答了 ${count} 个问题` : '回答了问题') : (count > 1 ? `没有回答这 ${count} 个问题` : '没有回答这个问题')}
      </div>
      {item.questions.map((question) => {
        const answers = settled ? questionAnswers(question, item.answers?.[question.id] ?? []) : []
        return (
          <div key={question.id} className="chat-ask-receipt-row">
            <div className="chat-ask-receipt-question">
              {question.header && <span className="chat-ask-chip">{question.header}</span>}
              {question.question}
            </div>
            {answers.length > 0 && (
              <div className="chat-ask-receipt-answers">
                {answers.map((answer) => (
                  <span key={answer.text} className="chat-ask-answer" data-typed={answer.typed || undefined}>
                    {answer.typed ? answer.text : answer.text.replace(RECOMMENDED, '')}
                    {answer.typed && <span className="chat-ask-typed">自填</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
