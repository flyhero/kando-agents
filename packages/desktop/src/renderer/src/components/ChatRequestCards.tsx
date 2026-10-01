import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { isHostApproval, type ChatDecision, type ChatItem, type ChatQuestion } from '@kando/protocol'
import { questionAnswers } from '../chat-state'
import { perform } from '../core-store'
import { commandKeyword, isCommandTool, toolLabel } from '../chat-tools'
import { ChatPaths } from './ChatToolCard'
import { CheckIcon } from './icons'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>
type QuestionItem = Extract<ChatItem, { kind: 'question' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = ApprovalItem | QuestionItem

const DECISION_LABEL: Record<ChatDecision, string> = { allow: '允许', allowForSession: '本会话都允许', deny: '拒绝' }
// A site is allowed for one visit or for the whole conversation; the words say so.
const HOST_DECISION_LABEL: Record<ChatDecision, string> = { allow: '允许一次', allowForSession: '本会话允许', deny: '拒绝' }
function decisionLabel(item: ApprovalItem, decision: ChatDecision): string {
  return (isHostApproval(item) ? HOST_DECISION_LABEL : DECISION_LABEL)[decision]
}
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
  // A command is named by the program it runs; the card below has it in full. Kando's own
  // question about a site names the site.
  const what = <>{toolLabel(item.tool)} <span className="mono">{isCommandTool(item.tool) ? commandKeyword(item.title) : isHostApproval(item) ? item.title : shorten(item.title)}</span></>
  return item.resolution === null
    ? <div className="chat-request-line" data-waiting>需要你确认：{what} · 在下方回答</div>
    : <div className="chat-request-line">{what} · {RESOLUTION_TEXT[item.resolution]}</div>
}

// A command in full, in a block of its own: three lines of it until opened, since one that chains
// several steps runs long, and the headline above already says what it is for.
const COMMAND_LINES = 3

function CommandBlock({ command }: { command: string }) {
  const [open, setOpen] = useState(false)
  const lines = command.split('\n')
  const long = lines.length > COMMAND_LINES || command.length > 200
  return (
    <div className="chat-approve-command" data-clipped={(long && !open) || undefined}>
      <pre>{command}</pre>
      {long && (
        <button type="button" className="link-button chat-approve-command-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

// A waiting approval, docked above the composer: what the agent wants to do and the answers it
// takes. The headline is the agent's own words for the call where it gave them, else the tool
// and what it acts on; a command is named by its program there and shown in full below, since
// the call's own line in the list has only its first line. The answers come as numbered rows,
// allowing first and refusing last, the reason for refusing typed on its own row; a number key
// picks a row, Enter sends the one picked.
const DECISION_ORDER: readonly ChatDecision[] = ['allow', 'allowForSession', 'deny']

export function ChatApprovalCard({ conversationId, item, tool }: { conversationId: string; item: ApprovalItem; tool: ToolItem | undefined }) {
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [reason, setReason] = useState('')
  const decisions = DECISION_ORDER.filter((decision) => item.decisions.includes(decision))
  const [choice, setChoice] = useState<ChatDecision>(decisions[0] ?? 'deny')
  const reasonInput = useRef<HTMLInputElement>(null)
  const shorten = useContext(ChatPaths)
  const command = isCommandTool(item.tool)
  const host = isHostApproval(item)
  const title = command ? commandKeyword(item.title) : host ? item.title : shorten(item.title)
  // Claude describes a file call by the file's name, which the title already has. A site's card
  // says the site in the headline and the whole address below.
  const detail = host ? null : item.detail && !title.includes(shorten(item.detail)) ? shorten(item.detail) : null
  const what = host
    ? <>agent 想打开 <span className="mono">{title}</span></>
    : <>{toolLabel(item.tool)} <span className="mono">{title}</span></>
  const submit = () => void respond(choice, choice === 'deny' && reason.trim() ? { message: reason.trim() } : {})
  const pick = (decision: ChatDecision) => {
    setChoice(decision)
    if (decision === 'deny') reasonInput.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!busy) submit()
    } else if (/^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      const decision = decisions[Number(event.key) - 1]
      if (decision) {
        event.preventDefault()
        pick(decision)
      }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && decisions.length > 1) {
      event.preventDefault()
      const at = decisions.indexOf(choice)
      const next = decisions[(at + (event.key === 'ArrowDown' ? 1 : -1) + decisions.length) % decisions.length]
      if (next) pick(next)
      if (next !== 'deny') reasonInput.current?.blur()
    }
  }
  return (
    <div className="chat-request" data-waiting onKeyDown={onKeyDown}>
      <div className="chat-request-title">需要你确认：{detail ?? what}</div>
      {detail && <p className="chat-request-detail muted">{what}</p>}
      {host && item.detail && <p className="chat-request-detail mono muted">{item.detail}</p>}
      {command && tool?.input
        ? <CommandBlock command={tool.input} />
        : tool?.input && <pre className="chat-tool-io">{tool.input}</pre>}
      <div className="chat-approve-options" role="radiogroup" aria-label="怎么回答">
        {decisions.map((decision, index) => (
          <div
            key={decision}
            role="radio"
            tabIndex={decision === 'deny' ? -1 : 0}
            aria-checked={choice === decision}
            className="chat-approve-option"
            onClick={() => pick(decision)}
          >
            <span className="chat-approve-number">{index + 1}.</span>
            {decision === 'deny' ? (
              <input
                ref={reasonInput}
                className="chat-approve-reason"
                aria-label="拒绝，并说明理由"
                placeholder="拒绝，并告诉 agent 为什么（可不填）"
                value={reason}
                disabled={busy}
                onFocus={() => setChoice('deny')}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setReason(event.target.value)}
              />
            ) : (
              <span>{decisionLabel(item, decision)}</span>
            )}
          </div>
        ))}
      </div>
      <div className="chat-approve-footer">
        <span className="chat-approve-hint">数字键选择 · Enter 提交</span>
        <button type="button" className="button primary" disabled={busy} onClick={submit}>
          {decisionLabel(item, choice)}<kbd>↵</kbd>
        </button>
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
  // Two more ways to answer, each behind a tab of its own: a note that goes with every pick, or
  // one reply in place of all the picks.
  const [mode, setMode] = useState<'question' | 'note' | 'reply'>('question')
  const [note, setNote] = useState('')
  const [reply, setReply] = useState('')
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
  const replying = reply.trim() !== ''
  const answer = (each: ChatQuestion) => {
    if (replying) return [reply.trim()]
    const own = answerOf(picked[each.id] ?? [], typing[each.id] ? typed[each.id] : undefined)
    return own.length > 0 && note.trim() ? [...own, note.trim()] : own
  }
  const answered = (each: ChatQuestion) => answer(each).length > 0
  const last = index === questions.length - 1
  const unanswered = questions.filter((each) => !answered(each)).length
  const submit = () => void respond('allow', { answers: Object.fromEntries(questions.map((each) => [each.id, answer(each)])) })
  const chosen = picked[question.id] ?? []
  const free = mode !== 'question'

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
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!busy) void respond('deny')
      return
    }
    if (event.target instanceof HTMLTextAreaElement) {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && unanswered === 0) {
        event.preventDefault()
        submit()
      }
      return
    }
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
    } else if (/^[1-9]$/.test(event.key) && !free) {
      const option = question.options[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        choose(option.label)
      }
    } else if (event.key === '0' && !free) {
      event.preventDefault()
      toggleTyping()
    }
  }

  return (
    <div className="chat-request chat-ask" data-waiting ref={card} onKeyDown={onKeyDown}>
      <div className="chat-ask-head">
        <div className="chat-ask-tabs" role="tablist" aria-label="问题">
          {questions.map((each, at) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={!free && at === index}
              className="chat-ask-tab"
              onClick={() => { setMode('question'); setIndex(at) }}
            >
              {answered(each) && !replying && <CheckIcon />}
              {questions.length > 1 ? (each.header || `Q${at + 1}`) : (each.header || '问题')}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={mode === 'note'} className="chat-ask-tab chat-ask-tab-alt" onClick={() => setMode('note')}>
            ✎ 补充说明{note.trim() && <CheckIcon />}
          </button>
          <button type="button" role="tab" aria-selected={mode === 'reply'} className="chat-ask-tab" onClick={() => setMode('reply')}>
            ⇄ 直接回复{replying && <CheckIcon />}
          </button>
        </div>
        <span className="chat-dock-spacer" />
        {questions.length > 1 && !free && <span className="chat-ask-count muted">{index + 1}/{questions.length}</span>}
      </div>
      {mode === 'note' && (
        <textarea
          className="chat-ask-free"
          rows={3}
          autoFocus
          value={note}
          placeholder="给 agent 的补充说明，会附在每个问题的回答后面；Enter 提交，Shift+Enter 换行"
          aria-label="补充说明"
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
      {mode === 'reply' && (
        <textarea
          className="chat-ask-free"
          rows={3}
          autoFocus
          value={reply}
          placeholder="不选选项，直接用一段话回答全部问题；Enter 提交，Shift+Enter 换行"
          aria-label="直接回复"
          disabled={busy}
          onChange={(event) => setReply(event.target.value)}
        />
      )}
      {!free && <div className="chat-ask-question" id={`${item.requestId}-question`}>
        {question.question}
        {question.multiSelect && <span className="chat-ask-hint muted">可多选</span>}
      </div>}
      {!free && <div
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
              <span className="chat-ask-key" data-multi={question.multiSelect || undefined}>{at < 9 ? at + 1 : ''}</span>
              <span className="chat-ask-text">
                <OptionLabel label={option.label} />
                {option.description && <span className="chat-ask-description">{option.description}</span>}
              </span>
              {on && <span className="chat-ask-check" aria-hidden="true"><CheckIcon /></span>}
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
            <span className="chat-ask-key" data-multi={question.multiSelect || undefined}>{question.options.length < 9 ? question.options.length + 1 : '…'}</span>
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
      </div>}
      <div className="chat-request-actions">
        <button type="button" className="button ghost" disabled={busy} onClick={() => void respond('deny')}>不回答<kbd>Esc</kbd></button>
        <span className="chat-dock-spacer" />
        {!free && index > 0 && <button type="button" className="button ghost" disabled={busy} onClick={() => setIndex(index - 1)}>上一个</button>}
        {free || last ? (
          <button
            type="button"
            className="button primary"
            disabled={busy || unanswered > 0}
            title={unanswered > 0 ? `还有 ${unanswered} 个问题没回答` : undefined}
            onClick={submit}
          >
            提交<kbd>↵</kbd>
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
