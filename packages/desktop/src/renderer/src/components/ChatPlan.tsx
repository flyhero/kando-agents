import { useState } from 'react'
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

// Docked above the composer: carry the plan out, with edits accepted or asked one by one, or
// send it back with a note. Where the chat may only plan, keep it for later instead.
export function ChatPlanCard({ conversationId, item }: { conversationId: string; item: PlanItem }) {
  const surface = useChatSurface()
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const { savePlan } = surface
  const save = async () => {
    if (!savePlan || saving) return
    setSaving(true)
    await savePlan(item)
    setSaving(false)
  }
  return (
    <div className="chat-request" data-waiting>
      <div className="chat-request-title">
        计划等你确认
        <button type="button" className="link-button" onClick={() => surface.showPlan(itemKey(item))}>查看计划</button>
      </div>
      {savePlan && <p className="chat-request-detail muted">依赖的任务还没完成：先保存计划，等它们完成后开始执行时再按计划做。</p>}
      <div className="chat-request-actions">
        <input
          className="input chat-request-reason"
          placeholder="要改哪里（继续规划时告诉 agent）"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button type="button" className="button ghost" disabled={busy || saving} onClick={() => void respond('deny', note.trim() ? { message: note.trim() } : {})}>继续规划</button>
        {savePlan ? (
          <button type="button" className="button primary" disabled={busy || saving} onClick={() => void save()}>保存计划</button>
        ) : (
          <>
            <button type="button" className="button" disabled={busy} onClick={() => void respond('allow')}>执行，逐项确认</button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void respond('allowForSession')}>执行，自动接受编辑</button>
          </>
        )}
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
