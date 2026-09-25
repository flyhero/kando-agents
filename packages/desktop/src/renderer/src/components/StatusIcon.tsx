import type { TaskStatus } from '@kando/protocol'
import { STATUS_HINT, STATUS_LABEL } from '../labels'

function Shape({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'pending':
      return <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    case 'running':
      return (
        <circle
          className="spin"
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray="26 12"
        />
      )
    case 'abandoned':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 12L12 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )
    case 'done':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path className="check" d="M5 8.3l2 2 4-4.3" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
  }
}

// `decorative` when a visible label sits next to the icon, so screen readers don't say it twice.
export function StatusIcon({ status, decorative = false }: { status: TaskStatus; decorative?: boolean }) {
  if (decorative) {
    return (
      <svg className="status-icon" data-status={status} viewBox="0 0 16 16" aria-hidden="true">
        <Shape status={status} />
      </svg>
    )
  }
  return (
    <svg className="status-icon" data-status={status} viewBox="0 0 16 16" role="img" aria-label={STATUS_LABEL[status]}>
      <title>{`${STATUS_LABEL[status]} · ${STATUS_HINT[status]}`}</title>
      <Shape status={status} />
    </svg>
  )
}
