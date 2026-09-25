import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Task, TaskProposal } from '@kando/protocol'
import { perform } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { CloseIcon, SparkIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'
import {
  MAX_PROPOSAL_PANEL_RATIO,
  MIN_PROPOSAL_PANEL_RATIO,
  clampProposalPanelRatio,
  proposalPanelRatioAtPointer
} from './proposal-panel-size'

const ignore = () => {}

type ProposalAction = 'replace' | 'append' | 'discard'

function submittedAt(proposal: TaskProposal): string {
  return new Date(proposal.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function author(proposal: TaskProposal): string {
  return proposal.agent ? AGENT_LABEL[proposal.agent] : 'agent'
}

// `onApplied` fires after replace or append, so a detail pane can remount its
// editor, which only reads its value once.
function ProposalActions({
  task,
  disabled = false,
  onApplied
}: {
  task: Task
  disabled?: boolean
  onApplied?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const hasDetails = task.details.trim() !== ''
  const resolve = async (action: ProposalAction) => {
    setBusy(true)
    const updated = await perform((rpc) => rpc.call('tasks.resolveProposal', { id: task.id, action }))
    setBusy(false)
    if (updated && action !== 'discard') {
      onApplied?.()
    }
  }
  const off = busy || disabled
  return (
    <div className="proposal-actions">
      <button type="button" className="button primary" disabled={off} onClick={() => void resolve('replace')}>
        {hasDetails ? '替换详情' : '用作详情'}
      </button>
      {hasDetails && (
        <button type="button" className="button" disabled={off} onClick={() => void resolve('append')}>
          追加到末尾
        </button>
      )}
      <button type="button" className="button ghost" disabled={off} onClick={() => void resolve('discard')}>
        放弃
      </button>
    </div>
  )
}

// Keyed by time: a resubmitted proposal must replace what the read-only view shows.
function ProposalPreview({ proposal }: { proposal: TaskProposal }) {
  return (
    <MarkdownEditor
      key={proposal.createdAt}
      value={proposal.markdown}
      onSave={ignore}
      label={`${author(proposal)} 提交的方案`}
      hint=""
      readOnly
    />
  )
}

// Inline in the detail pane, for a proposal that arrived while the user was there.
export function ProposalCard({ task, onApplied }: { task: Task; onApplied: () => void }) {
  const { proposal } = task
  if (!proposal) {
    return null
  }
  return (
    <section className="proposal" aria-label={`${author(proposal)} 提交的方案`}>
      <header className="proposal-header">
        <span className="proposal-icon">
          <SparkIcon />
        </span>
        <span className="proposal-title">{author(proposal)} 提交了新的任务详情</span>
        <span className="muted">{submittedAt(proposal)}</span>
        <ProposalActions task={task} onApplied={onApplied} />
      </header>
      <ProposalPreview proposal={proposal} />
    </section>
  )
}

// Beside the refining terminal, so the plan and the conversation about it stay in view together.
// `proposal` is passed separately: while sliding out it is the one just resolved.
export function ProposalPanel({
  task,
  proposal,
  closing,
  widthRatio,
  onWidthRatioChange,
  onClose,
  onClosed
}: {
  task: Task
  proposal: TaskProposal
  closing: boolean
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
  onClose: () => void
  onClosed: () => void
}) {
  const separator = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) {
      return
    }
    document.body.classList.add('proposal-panel-resizing')
    return () => document.body.classList.remove('proposal-panel-resizing')
  }, [dragging])

  const resizeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const element = separator.current
    const container = element?.parentElement
    if (!element || !container) {
      return
    }
    const bounds = container.getBoundingClientRect()
    onWidthRatioChange(proposalPanelRatioAtPointer(event.clientX, bounds.left, bounds.width, element.offsetWidth))
  }
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
    if (direction === 0) {
      return
    }
    event.preventDefault()
    onWidthRatioChange(clampProposalPanelRatio(widthRatio + direction * 0.02))
  }

  return (
    <>
      <div
        ref={separator}
        className="proposal-panel-separator"
        data-dragging={dragging}
        data-closing={closing}
        role="separator"
        aria-label="调整终端与方案面板宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_PROPOSAL_PANEL_RATIO * 100}
        aria-valuemax={MAX_PROPOSAL_PANEL_RATIO * 100}
        aria-valuenow={Math.round(widthRatio * 100)}
        aria-valuetext={`方案面板占 ${Math.round(widthRatio * 100)}%`}
        tabIndex={closing ? -1 : 0}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (closing || event.button !== 0) {
            return
          }
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
          resizeAtPointer(event)
        }}
        onPointerMove={(event) => dragging && resizeAtPointer(event)}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={() => setDragging(false)}
      />
      <aside
        className="proposal-panel"
        data-closing={closing}
        aria-label={`${author(proposal)} 提交的方案`}
        style={{ flexBasis: `calc((100% - var(--proposal-panel-separator-size)) * ${widthRatio})` }}
        // animationend bubbles; only the panel's own slide-out means it is gone.
        onAnimationEnd={(event) => closing && event.target === event.currentTarget && onClosed()}
      >
        <header className="proposal-panel-header">
          <span className="proposal-icon">
            <SparkIcon />
          </span>
          <span className="proposal-title">{author(proposal)} 提交的方案</span>
          <span className="muted">{submittedAt(proposal)}</span>
          <button type="button" className="tool-button proposal-panel-close" aria-label="收起" data-tooltip="收起" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p className="proposal-panel-hint">哪里不满意，直接在左边的终端里告诉 agent，它改完会重新提交。</p>
        <div className="proposal-panel-body">
          <ProposalPreview proposal={proposal} />
        </div>
        <footer className="proposal-panel-footer">
          <ProposalActions task={task} disabled={closing} />
        </footer>
      </aside>
    </>
  )
}

export function RestoreBar({ task, onRestored }: { task: Task; onRestored: () => void }) {
  if (task.previousDetails === null || task.proposal) {
    return null
  }
  const restore = async () => {
    if (await perform((rpc) => rpc.call('tasks.restoreDetails', { id: task.id }))) {
      onRestored()
    }
  }
  return (
    <p className="restore-bar" role="status">
      详情已按 agent 的方案更新，改动前的版本还留着。
      <button type="button" className="link-button" onClick={() => void restore()}>
        撤销
      </button>
    </p>
  )
}
