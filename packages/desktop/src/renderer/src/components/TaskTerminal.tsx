import { useCallback, useEffect, useState } from 'react'
import { shortTaskId, type TaskProposal } from '@kando/protocol'
import { perform, useCore } from '../core-store'
import { AGENT_LABEL, STATUS_LABEL } from '../labels'
import { BranchStatus } from './BranchStatus'
import { projectNames } from './ProjectPicker'
import { ProposalPanel } from './ProposalCard'
import { SessionTerminal } from './SessionTerminal'
import { SourceLink } from './SourceLink'
import { StatusIcon } from './StatusIcon'
import { TaskAlerts } from './TaskAlerts'
import { TaskToolbar } from './TaskActions'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'

type PanelState = 'open' | 'closing' | 'closed'

// The agent's session given the whole pane; the task's details are one click away.
export function TaskTerminal({ taskId }: { taskId: string }) {
  const task = useCore((s) => s.tasks[taskId])
  // An open refining conversation is the live one; otherwise the last run.
  const live = task?.refineSessionId ?? task?.sessionId ?? null
  // Stay on a session after it ends (its transcript is what the user is reading),
  // until another one starts.
  const [sessionId, setSessionId] = useState(live)
  const starting = task?.refineSessionId ?? (task?.status === 'running' ? task.sessionId : null) ?? null
  useEffect(() => {
    if (starting) {
      setSessionId(starting)
    }
  }, [starting])

  // Each submitted proposal slides the panel in; resolving it slides the panel out.
  // The last proposal is kept so the panel still has content while it leaves.
  const proposal = task?.proposal ?? null
  const [panel, setPanel] = useState<PanelState>(proposal ? 'open' : 'closed')
  const [shown, setShown] = useState<TaskProposal | null>(proposal)
  const [sidePanelRatio, setSidePanelRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  useEffect(() => {
    if (proposal) {
      setShown(proposal)
      setPanel('open')
    } else {
      setPanel((current) => (current === 'open' ? 'closing' : current))
    }
  }, [proposal?.createdAt])

  const finishClosingPanel = useCallback(() => {
    setPanel('closed')
    setSidePanelRatio(DEFAULT_SIDE_PANEL_RATIO)
  }, [])

  if (!task) {
    return null
  }
  const restore = () => void perform((rpc) => rpc.call('tasks.restoreDetails', { id: task.id }))

  return (
    <section className="detail terminal-view" aria-label={`${task.title} 的终端`}>
      {/* Laid out like a conversation's header: what runs where first, then this task's own state. */}
      <header className="detail-header task-terminal-header">
        <StatusIcon status={task.status} decorative />
        <span className="terminal-view-title" title={task.title}>
          {task.title}
        </span>
        {task.agent && <span className="muted">{AGENT_LABEL[task.agent]}</span>}
        {task.repos.length > 0 && (
          <span className="muted" title={task.repos.map((repo) => repo.path).join('\n')}>
            {projectNames(task.repos.map((repo) => repo.path))}
          </span>
        )}
        <BranchStatus target={{ kind: 'task', id: task.id }} updatedAt={task.updatedAt} />
        <span className="status-pill" data-status={task.status}>
          {STATUS_LABEL[task.status]}
        </span>
        <TaskAlerts task={task} />
        <span className="muted mono">{shortTaskId(task.id)}</span>
        <SourceLink task={task} />
        {task.refineSessionId && <span className="task-tag task-tag-refining">细化中</span>}
        {task.proposal && panel !== 'open' && (
          <button type="button" className="task-tag task-tag-proposal" onClick={() => setPanel('open')}>
            查看方案
          </button>
        )}
        {!task.proposal && task.previousDetails !== null && (
          <button type="button" className="task-tag task-tag-updated" onClick={restore}>
            详情已更新 · 撤销
          </button>
        )}
        <TaskToolbar task={task} view="terminal" />
      </header>
      <div className="terminal-body">
        {sessionId ? (
          <SessionTerminal key={sessionId} sessionId={sessionId} />
        ) : (
          <p className="terminal-view-empty muted">正在启动 agent…</p>
        )}
        {panel !== 'closed' && shown && (
          <ProposalPanel
            task={task}
            proposal={shown}
            closing={panel === 'closing'}
            widthRatio={sidePanelRatio}
            onWidthRatioChange={setSidePanelRatio}
            onClose={() => setPanel('closing')}
            onClosed={finishClosingPanel}
          />
        )}
      </div>
    </section>
  )
}
