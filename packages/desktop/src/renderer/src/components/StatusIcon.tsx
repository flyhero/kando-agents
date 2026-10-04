import { useId, useState } from 'react'
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
    // Half full: the work is there, the user has not taken it yet.
    case 'review':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </>
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
          <path className="check" d="M5 8.3l2 2 4-4.3" pathLength={1} fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
  }
}

// How many times the status changed while the icon was mounted: a task that moves before the user's
// eyes grows into its new shape, one that was already showing keeps still. Counted while rendering,
// not in an effect, so the new shape never shows for a frame before it animates.
function useChanges(status: TaskStatus): number {
  const [seen, setSeen] = useState(status)
  const [changes, setChanges] = useState(0)
  if (status !== seen) {
    setSeen(status)
    setChanges(changes + 1)
  }
  return changes
}

function Glyph({ status }: { status: TaskStatus }) {
  const changes = useChanges(status)
  const mask = useId()
  const shape = (
    <g key={changes} className={changes > 0 ? 'status-enter' : undefined}>
      <Shape status={status} />
    </g>
  )
  if (status !== 'pending') {
    return shape
  }
  // A pending task waiting on others has its ring cut at the top right, with a badge in the cut.
  // Both stay drawn while it waits on none, scaled to nothing, so the cut closes as the last is done.
  return (
    <>
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" />
        <circle className="status-blocker" cx="13" cy="3" r="4.25" fill="black" />
      </mask>
      <g mask={`url(#${mask})`}>{shape}</g>
      <g className="status-blocker">
        <circle cx="13" cy="3" r="2.75" />
        <path d="M11.75 3h2.5" />
      </g>
    </>
  )
}

// `waiting`: how many dependencies a pending task still waits on (see `waitingOn`).
// `decorative` when a visible label sits next to the icon, so screen readers don't say it twice.
export function StatusIcon({ status, waiting = 0, decorative = false }: { status: TaskStatus; waiting?: number; decorative?: boolean }) {
  const blocked = status === 'pending' && waiting > 0
  if (decorative) {
    return (
      <svg className="status-icon" data-status={status} data-blocked={blocked || undefined} viewBox="0 0 16 16" aria-hidden="true">
        <Glyph status={status} />
      </svg>
    )
  }
  const label = blocked ? `${STATUS_LABEL[status]}，等待 ${waiting} 个任务` : STATUS_LABEL[status]
  const hint = blocked ? `等待 ${waiting} 个任务完成` : STATUS_HINT[status]
  return (
    <svg className="status-icon" data-status={status} data-blocked={blocked || undefined} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{`${STATUS_LABEL[status]} · ${hint}`}</title>
      <Glyph status={status} />
    </svg>
  )
}
