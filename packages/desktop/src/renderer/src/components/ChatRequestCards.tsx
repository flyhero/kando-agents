import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { isHostApproval, TERMINAL_RUN_TOOL, terminalToolKind, type ChatDecision, type ChatItem, type ChatPermissionMode, type ChatQuestion } from '@kando/protocol'
import { choiceAction, choiceText, chosenText, isPlainDeny } from '../approval-choice-text'
import { questionAnswers } from '../chat-state'
import { perform } from '../core-store'
import { commandKeyword, isCommandTool, toolLabel } from '../chat-tools'
import { ChatPaths } from './ChatToolCard'
import { CheckIcon } from './icons'
import { ChatToolInput } from './ChatToolInput'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>
type QuestionItem = Extract<ChatItem, { kind: 'question' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
export type RequestItem = ApprovalItem | QuestionItem

const DECISION_LABEL: Record<ChatDecision, string> = { allow: '允许', allowForSession: '本会话都允许', deny: '拒绝' }
// A site is allowed for one visit or for the whole conversation; the words say so.
const HOST_DECISION_LABEL: Record<ChatDecision, string> = { allow: '允许一次', allowForSession: '本会话允许', deny: '拒绝' }
// Kando's own question before an agent's command runs in a terminal of its own.
const TERMINAL_DECISION_LABEL: Record<ChatDecision, string> = { allow: '运行这一次', allowForSession: '本会话都允许在终端运行', deny: '拒绝' }

// A request to run a command in a terminal of the agent's own: Kando's (the command is its title)
// or the agent's own permission prompt for the tool (the command is in the call's input).
function terminalCommand(item: Extract<ChatItem, { kind: 'approval' }>, input: string | null | undefined): string | null {
  if (item.tool === TERMINAL_RUN_TOOL) return item.title
  if (terminalToolKind(item.tool) !== 'run') return null
  try {
    const parsed: unknown = JSON.parse(input ?? '')
    if (parsed && typeof parsed === 'object' && 'command' in parsed && typeof parsed.command === 'string') return parsed.command
  } catch {
    // Not the call's JSON: the title has the command's first line.
  }
  return item.title
}
function decisionLabel(item: ApprovalItem, decision: ChatDecision): string {
  return (isHostApproval(item) ? HOST_DECISION_LABEL : item.tool === TERMINAL_RUN_TOOL ? TERMINAL_DECISION_LABEL : DECISION_LABEL)[decision]
}
const RESOLUTION_TEXT: Record<NonNullable<ApprovalItem['resolution']>, string> = {
  allowed: '已允许',
  allowedForSession: '已允许，本会话不再询问',
  denied: '已拒绝',
  cancelled: '已取消'
}

export function useResponder(conversationId: string, requestId: string) {
  const [busy, setBusy] = useState(false)
  // Whether the answer went through.
  const respond = async (decision: ChatDecision, extra: { choice?: string; mode?: ChatPermissionMode; message?: string; answers?: Record<string, string[]> } = {}): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    const done = await perform((rpc) => rpc.call('conversations.respond', { id: conversationId, requestId, decision, ...extra }))
    setBusy(false)
    return done !== null
  }
  return { busy, respond }
}

// Where a request sits in the conversation: one line, pointing down to its card while it waits,
// and saying how it went once answered. An answered question leaves what was asked and answered.
export function ChatRequestLine({ item }: { item: RequestItem }) {
  const shorten = useContext(ChatPaths)
  if (item.kind === 'question') {
    if (item.resolution !== null) return <ChatQuestionReceipt item={item} />
    return <div className="chat-request-line" data-waiting>Agent 在问你：{item.questions[0]?.question ?? ''} · 在下方回答</div>
  }
  // A command is named by the program it runs; the card below has it in full. Kando's own
  // question about a site names the site.
  const what = <>{toolLabel(item.tool)} <span className="mono">{isCommandTool(item.tool) ? commandKeyword(item.title) : isHostApproval(item) ? item.title : shorten(item.title)}</span></>
  return item.resolution === null
    ? <div className="chat-request-line" data-waiting>需要你确认：{what} · 在下方回答</div>
    : <div className="chat-request-line">{what} · {chosenText(item) ?? RESOLUTION_TEXT[item.resolution]}</div>
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

// One row of an approval: answered by a choice where the agent described its answers, else by
// the decision. denies: the plain no, whose row takes the reason.
type ApprovalOption = { key: string; decision: ChatDecision; choice: string | null; label: string; note: string | null; action: string; denies: boolean }

function approvalOptions(item: ApprovalItem): ApprovalOption[] {
  if (item.choices?.length) {
    // The plain no goes last, where its row takes the reason; the rest keep the agent's order.
    const ordered = [...item.choices.filter((choice) => !isPlainDeny(choice)), ...item.choices.filter(isPlainDeny)]
    return ordered.map((choice) => ({ key: choice.id, decision: choice.decision, choice: choice.id, ...choiceText(choice), action: choiceAction(choice), denies: isPlainDeny(choice) }))
  }
  return DECISION_ORDER.filter((decision) => item.decisions.includes(decision)).map((decision) => ({
    key: decision, decision, choice: null, label: decisionLabel(item, decision), note: null, action: decisionLabel(item, decision), denies: decision === 'deny'
  }))
}

export function ChatApprovalCard({ conversationId, item, tool }: { conversationId: string; item: ApprovalItem; tool: ToolItem | undefined }) {
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [reason, setReason] = useState('')
  const options = approvalOptions(item)
  const [picked, setPicked] = useState(options[0]?.key ?? '')
  const current = options.find((option) => option.key === picked) ?? options[0]
  // Nothing here remembers anything, so the same kind of call will ask again.
  const remembersNothing = item.choices !== undefined && !item.choices.some((choice) => choice.grants.length > 0)
  const reasonInput = useRef<HTMLInputElement>(null)
  const shorten = useContext(ChatPaths)
  const command = isCommandTool(item.tool)
  const host = isHostApproval(item)
  const terminal = terminalCommand(item, tool?.input)
  const title = command ? commandKeyword(item.title) : host ? item.title : shorten(item.title)
  // Claude describes a file call by the file's name, which the title already has. A site's card
  // says the site in the headline and the whole address below.
  const detail = host ? null : item.detail && !title.includes(shorten(item.detail)) ? shorten(item.detail) : null
  const what = host
    ? <>Agent 想打开 <span className="mono">{title}</span></>
    : terminal !== null
      ? <>Agent 想在终端里运行 <span className="mono">{commandKeyword(terminal)}</span></>
      : <>{toolLabel(item.tool)} <span className="mono">{title}</span></>
  const submit = () => {
    if (!current) return
    void respond(current.decision, {
      ...(current.choice ? { choice: current.choice } : {}),
      ...(current.denies && reason.trim() ? { message: reason.trim() } : {})
    })
  }
  const pick = (option: ApprovalOption) => {
    setPicked(option.key)
    if (option.denies) reasonInput.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!busy) submit()
    } else if (/^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      const option = options[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        pick(option)
      }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length > 1) {
      event.preventDefault()
      const at = options.findIndex((option) => option.key === current?.key)
      const next = options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]
      if (next) pick(next)
      if (!next?.denies) reasonInput.current?.blur()
    }
  }
  return (
    <div className="chat-request" data-waiting onKeyDown={onKeyDown}>
      <div className="chat-request-title">需要你确认：{terminal !== null ? what : detail ?? what}</div>
      {detail && terminal === null && <p className="chat-request-detail muted">{what}</p>}
      {host && item.detail && <p className="chat-request-detail mono muted">{item.detail}</p>}
      {item.reason && <p className="chat-request-detail muted">Agent 停下来问的原因：{item.reason}</p>}
      {terminal !== null ? (
        <>
          <CommandBlock command={terminal} />
          <p className="chat-request-detail muted">在 Kando 的终端面板里开一个标签运行，你能看到输出，随时可以停掉。{item.tool === TERMINAL_RUN_TOOL && item.detail ? `目录：${item.detail}` : ''}</p>
        </>
      ) : command && tool?.input
        ? <CommandBlock command={tool.input} />
        : tool?.input && <ChatToolInput name={tool.name} input={tool.input} />}
      <div className="chat-approve-options" role="radiogroup" aria-label="怎么回答">
        {options.map((option, index) => (
          <div
            key={option.key}
            role="radio"
            tabIndex={option.denies ? -1 : 0}
            aria-checked={current?.key === option.key}
            className="chat-approve-option"
            onClick={() => pick(option)}
          >
            <span className="chat-approve-number">{index + 1}.</span>
            {option.denies ? (
              <input
                ref={reasonInput}
                className="chat-approve-reason"
                aria-label="拒绝，并说明理由"
                placeholder="拒绝，并告诉 Agent 为什么（可不填）"
                value={reason}
                disabled={busy}
                onFocus={() => setPicked(option.key)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setReason(event.target.value)}
              />
            ) : (
              <span className="chat-approve-label">
                <span>{option.label}</span>
                {option.note && <span className="chat-approve-note">{option.note}</span>}
              </span>
            )}
          </div>
        ))}
      </div>
      {remembersNothing && <p className="chat-request-detail muted">这次没有能记住的规则，同类调用之后还会问；想少问几次，可以在输入框下方换个权限模式。</p>}
      <div className="chat-approve-footer">
        <span className="chat-approve-hint">数字键选择 · Enter 提交</span>
        <button type="button" className="button primary" disabled={busy || !current} onClick={submit}>
          {current?.action ?? '拒绝'}<kbd>↵</kbd>
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
        {item.async && <span className="chat-ask-async muted">Agent 没停下来等 · 回答会作为消息发给它</span>}
        {questions.length > 1 && !free && <span className="chat-ask-count muted">{index + 1}/{questions.length}</span>}
      </div>
      {mode === 'note' && (
        <textarea
          className="chat-ask-free"
          rows={3}
          autoFocus
          value={note}
          placeholder="给 Agent 的补充说明，会附在每个问题的回答后面；Enter 提交，Shift+Enter 换行"
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
        {settled ? (count > 1 ? `回答了 ${count} 个问题` : '回答了问题') : item.async ? '没有用选项回答' : (count > 1 ? `没有回答这 ${count} 个问题` : '没有回答这个问题')}
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
