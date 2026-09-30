import { useState, useRef, type KeyboardEvent } from 'react'
import { itemKey, type PlanItem } from '../chat-state'
import { useChatSurface } from './chat-surface'
import { ChatMarkdown } from './ChatMarkdown'
import { useResponder } from './ChatRequestCards'

// A plan Claude proposes from plan mode reads beside the conversation, in the inspector; the
// list and the dock only point to it, and the dock takes the answer.

const RESOLUTION: Record<NonNullable<PlanItem['resolution']>, string> = {
  allowed: '按计划执行，逐项确认',
  allowedForSession: '按计划执行，自动接受编辑',
  denied: '继续规划',
  cancelled: '已取消'
}

function status(plan: PlanItem): string {
  return plan.resolution === null ? '等你确认' : RESOLUTION[plan.resolution]
}

export function ChatPlanLine({ item }: { item: PlanItem }) {
  const surface = useChatSurface()
  const waiting = item.resolution === null
  const note = surface.planNote(item)
  return (
    <button type="button" className="chat-request-line chat-plan-line" data-waiting={waiting || undefined} onClick={() => surface.showPlan(itemKey(item))}>
      {waiting ? '计划等你确认 · 在右侧查看，在下方回答' : `计划 · ${note ?? status(item)} · 查看`}
    </button>
  )
}

// In the composer's place while the plan waits: the plan itself, clipped until opened, then the
// answers as numbered rows like any approval's. Carry it out with edits asked about or accepted,
// or send it back with a note; where the chat may only plan, keep it for later instead.
type PlanChoice = 'allow' | 'allowForSession' | 'save' | 'revise'
const CHOICE_LABEL: Record<Exclude<PlanChoice, 'revise'>, string> = {
  allow: '按计划执行，改文件、跑命令前逐项确认',
  allowForSession: '按计划执行，文件改动自动接受',
  save: '先保存计划，等依赖的任务完成后再执行'
}
const SUBMIT_LABEL: Record<PlanChoice, string> = { allow: '执行', allowForSession: '执行', save: '保存计划', revise: '继续规划' }
const PREVIEW_LINES = 12

export function ChatPlanCard({ conversationId, item }: { conversationId: string; item: PlanItem }) {
  const surface = useChatSurface()
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const { savePlan } = surface
  const choices: PlanChoice[] = savePlan ? ['save', 'revise'] : ['allow', 'allowForSession', 'revise']
  const [choice, setChoice] = useState<PlanChoice>(choices[0] ?? 'revise')
  const noteInput = useRef<HTMLInputElement>(null)
  const long = (item.detail ?? '').split('\n').length > PREVIEW_LINES
  const submit = async () => {
    if (busy || saving) return
    if (choice === 'save') {
      if (!savePlan) return
      setSaving(true)
      await savePlan(item)
      setSaving(false)
    } else if (choice === 'revise') {
      await respond('deny', note.trim() ? { message: note.trim() } : {})
    } else {
      await respond(choice)
    }
  }
  const pick = (next: PlanChoice) => {
    setChoice(next)
    if (next === 'revise') noteInput.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (/^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      const next = choices[Number(event.key) - 1]
      if (next) {
        event.preventDefault()
        pick(next)
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = choices.indexOf(choice)
      const next = choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]
      if (next) pick(next)
      if (next !== 'revise') noteInput.current?.blur()
    }
  }
  return (
    <div className="chat-request chat-plan" data-waiting onKeyDown={onKeyDown}>
      <div className="chat-request-title">
        计划等你确认
        <button type="button" className="link-button" onClick={() => surface.showPlan(itemKey(item))}>在检查器里看完整计划</button>
      </div>
      {savePlan && <p className="chat-request-detail muted">依赖的任务还没完成：现在只能保存计划，等它们完成后开始执行时再按计划做。</p>}
      {item.detail && (
        <div className="chat-plan-preview" data-clipped={(long && !open) || undefined}>
          <ChatMarkdown text={item.detail} />
          {long && (
            <button type="button" className="link-button chat-plan-preview-more" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}
      <div className="chat-approve-options" role="radiogroup" aria-label="怎么回答">
        {choices.map((each, index) => (
          <div
            key={each}
            role="radio"
            tabIndex={each === 'revise' ? -1 : 0}
            aria-checked={choice === each}
            className="chat-approve-option"
            onClick={() => pick(each)}
          >
            <span className="chat-approve-number">{index + 1}.</span>
            {each === 'revise' ? (
              <input
                ref={noteInput}
                className="chat-approve-reason"
                aria-label="继续规划，告诉 agent 要改哪里"
                placeholder="继续规划，告诉 agent 要改哪里（可不填）"
                value={note}
                disabled={busy || saving}
                onFocus={() => setChoice('revise')}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setNote(event.target.value)}
              />
            ) : (
              <span>{CHOICE_LABEL[each]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="chat-approve-footer">
        <span className="chat-approve-hint">数字键选择 · Enter 提交</span>
        <button type="button" className="button primary" disabled={busy || saving} onClick={() => void submit()}>
          {SUBMIT_LABEL[choice]}<kbd>↵</kbd>
        </button>
      </div>
    </div>
  )
}

// The inspector's plan tab: the newest plan, or an earlier version the user picked. It shows beside
// the chat rather than in it, so it is told how to pick a version and what its owner kept.
export function ChatPlanView({ plans, selected, onSelect, note = () => null }: {
  plans: readonly PlanItem[]
  selected: string | null
  onSelect: (key: string) => void
  note?: (item: PlanItem) => string | null
}) {
  const plan = plans.find((each) => itemKey(each) === selected) ?? plans.at(-1)
  const said = (each: PlanItem) => note(each) ?? status(each)
  if (!plan) return <p className="inspector-empty muted">agent 还没有提出计划。</p>
  return (
    <div className="chat-plan-view">
      <div className="chat-plan-view-status" data-waiting={plan.resolution === null || undefined}>
        {plans.length > 1 ? (
          <select className="chat-select" aria-label="计划的版本" value={itemKey(plan)} onChange={(event) => onSelect(event.target.value)}>
            {plans.map((each, index) => <option key={itemKey(each)} value={itemKey(each)}>第 {index + 1} 版 · {said(each)}</option>)}
          </select>
        ) : said(plan)}
        {plan.resolution === null && <span className="muted"> · 在对话下方确认</span>}
      </div>
      {plan.detail ? <ChatMarkdown text={plan.detail} /> : <p className="muted">这份计划是空的。</p>}
    </div>
  )
}
