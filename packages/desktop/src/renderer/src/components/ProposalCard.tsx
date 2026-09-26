import { useState } from 'react'
import type { Task, TaskProposal } from '@kando/protocol'
import { perform } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { CloseIcon, SparkIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'
import { PanelSeparator } from './PanelSeparator'

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
  return (
    <>
      <PanelSeparator panelName="方案面板" ratio={widthRatio} onRatioChange={onWidthRatioChange} disabled={closing} />
      <aside
        className="side-panel proposal-panel"
        data-closing={closing}
        aria-label={`${author(proposal)} 提交的方案`}
        style={{ flexBasis: `calc((100% - var(--side-panel-separator-size)) * ${widthRatio})` }}
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
