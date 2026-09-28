import { useState } from 'react'
import type { Task } from '@kando/protocol'
import { AGENT_LABEL, dayAndTime } from '../labels'
import { ChevronDownIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'

const ignore = () => {}

// The plan settled in the task's chat, read-only: the details stay as the user wrote them. A saved
// one waits for the task to run, so it opens; an approved one is already being carried out.
export function TaskPlanCard({ task }: { task: Task }) {
  const { plan } = task
  const [open, setOpen] = useState(plan ? !plan.approved : false)
  if (!plan) {
    return null
  }
  const title = plan.approved ? '已确认的计划' : '已保存的计划'
  return (
    <section className="snapshot" data-open={open || undefined} aria-label={title}>
      <header className="snapshot-header">
        <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDownIcon />
          {title}
        </button>
        <span className="muted">
          {AGENT_LABEL[plan.agent]} · {dayAndTime(plan.createdAt)}
          {!plan.approved && ' · 开始执行时交给 agent'}
        </span>
      </header>
      {open && (
        <MarkdownEditor key={plan.createdAt} value={plan.markdown} onSave={ignore} label={title} hint="" readOnly />
      )}
    </section>
  )
}
