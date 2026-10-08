import { useEffect, useMemo, useState } from 'react'
import { checkChatResume, shortTaskId, type Task } from '@kando/protocol'
import { usePlans, type PlanItem } from '../chat-state'
import { loadConversation, perform, showBrowserPanel, showInspectorFile, showTaskChanges, showTaskPlan, useChatOptionsSupported, useCore, useWireLogShown } from '../core-store'
import { locateInspectorFile } from '../inspector-file'
import { AGENT_LABEL, reasonText, STATUS_LABEL } from '../labels'
import { usePreferences } from '../preferences'
import { waitingOn } from '../task-waiting'
import { confirmQuota } from './AgentQuota'
import { BranchStatus } from './BranchStatus'
import type { ChatSurface } from './chat-surface'
import { ConversationChat } from './ConversationChat'
import { primaryProjectName } from './ProjectPicker'
import { DEFAULT_SIDE_PANEL_RATIO } from './side-panel-size'
import { EMPTY_FILE_TABS, useFileTabs } from '../file-tabs'
import { SourceLink } from './SourceLink'
import { StatusIcon } from './StatusIcon'
import { TaskInspector } from './TaskInspector'
import { TaskAlerts } from './TaskAlerts'
import { TaskToolbar } from './TaskActions'

// What the task kept of a plan in its chat: saved for when it can run. An approved one reads as its
// answer already does, so it needs no word.
function planNote(task: Task, item: PlanItem): string | null {
  const { plan } = task
  const kept = plan && plan.stageId === item.stageId && plan.requestId === item.requestId
  return kept && !plan.approved ? '已保存，依赖完成后执行' : null
}

// A message to a task's chat goes through the task first unless its agent is at work: the task checks
// what it may do, lays its worktrees out and goes back to running. A planning agent is checked every
// time, as the task's projects may change while it plans and it should follow them.
function taskSurface(task: Task, dependencies: readonly Task[], planOnly: boolean, bypassable: boolean): ChatSurface {
  const blocker = checkChatResume(task, dependencies)
  return {
    inspector: 'task',
    showPlan: showTaskPlan,
    showChanges: showTaskChanges,
    showFileChange: (path) => {
      const conversation = task.conversationId ? useCore.getState().conversations[task.conversationId] : undefined
      if (!conversation) return
      const projects = task.repos.flatMap((repo) => repo.worktreePath ? [{ project: repo.path, folder: repo.worktreePath }] : [])
      const found = locateInspectorFile(path, conversation.workspacePath, projects)
      if (found) showInspectorFile('task', task.id, found.project, found.file)
    },
    showBrowser: () => showBrowserPanel(task.conversationId),
    changes: task.repos.some((repo) => repo.worktreePath !== null) ? { kind: 'task', id: task.id } : null,
    changesHint: '任务 worktree 里还没提交的改动；点开检查器看',
    prepareSend: async (stopped) => {
      if (!stopped && task.status === 'running') return true
      if (stopped && task.agent && !confirmQuota(task.agent)) return false
      const allowBypass = bypassable ? { allowBypass: usePreferences.getState().allowBypass } : {}
      return Boolean(await perform((rpc) => rpc.call('tasks.resumeChat', { id: task.id, ...allowBypass })))
    },
    sendBlocker: blocker && reasonText(blocker, blocker),
    savePlan: planOnly
      ? async (item) => {
          await perform((rpc) => rpc.call('tasks.savePlan', { id: task.id, stageId: item.stageId, requestId: item.requestId }))
        }
      : null,
    planNote: (item) => planNote(task, item),
    handoff: null,
    fork: null
  }
}

// A started task: its chat, the task's own header and toolbar above, and the task's inspector beside
// it with the plans its agent proposed.
export function TaskChat({ taskId }: { taskId: string }) {
  const task = useCore((s) => s.tasks[taskId])
  const tasks = useCore((s) => s.tasks)
  const conversationId = task?.conversationId ?? null
  const conversation = useCore((s) => (conversationId ? s.conversations[conversationId] : undefined))
  const inspectorOpen = useCore((s) => s.inspectorOpen)
  const bypassable = useChatOptionsSupported()
  const [sidePanelRatio, setSidePanelRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const files = useFileTabs((state) => state[conversationId ?? ''] ?? EMPTY_FILE_TABS)
  const plans = usePlans(conversationId ?? '')
  const wire = useWireLogShown() && conversationId !== null

  useEffect(() => {
    if (conversationId && !conversation) void loadConversation(conversationId)
  }, [conversationId, conversation])

  // Handed in for review, the task opens on what it changed.
  const status = task?.status
  useEffect(() => {
    if (status === 'review') showTaskChanges()
  }, [status])

  const dependencies = useMemo(
    () => (task ? task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined) : []),
    [task, tasks]
  )
  const surface = useMemo(
    () => (task ? taskSurface(task, dependencies, conversation?.planOnly ?? false, bypassable) : null),
    [task, dependencies, conversation?.planOnly, bypassable]
  )
  if (!task || !surface) {
    return null
  }
  const worktree = task.repos.some((repo) => repo.worktreePath !== null)
  const showInspector = inspectorOpen && (worktree || plans.length > 0 || wire || files.tabs.length > 0)

  return (
    <section className="detail terminal-view" aria-label={`${task.title} 的聊天`}>
      <header className="detail-header task-terminal-header">
        <StatusIcon status={task.status} waiting={waitingOn(task, tasks)} decorative />
        <div className="header-meta">
          <span className="terminal-view-title" title={task.title}>
            {task.title}
          </span>
          {task.agent && <span className="muted">{AGENT_LABEL[task.agent]}</span>}
          {task.repos.length > 0 && (
            <span className="muted" title={task.repos.map((repo) => repo.path).join('\n')}>
              {primaryProjectName(task.repos.map((repo) => repo.path))}
            </span>
          )}
          <BranchStatus target={{ kind: 'task', id: task.id }} updatedAt={task.updatedAt} />
          <span className="status-pill" data-status={task.status}>
            {STATUS_LABEL[task.status]}
          </span>
          <TaskAlerts task={task} />
          <span className="muted mono">{shortTaskId(task.id)}</span>
          <SourceLink task={task} />
          {conversation?.planOnly && <span className="task-tag task-tag-refining">只读规划</span>}
        </div>
        <TaskToolbar task={task} view="chat" />
      </header>
      <div className="terminal-body">
        {conversation ? (
          <ConversationChat conversation={conversation} surface={surface} />
        ) : (
          <p className="terminal-view-empty muted">正在读取聊天记录…</p>
        )}
        {showInspector && (
          <TaskInspector
            task={task}
            widthRatio={sidePanelRatio}
            onWidthRatioChange={setSidePanelRatio}
            plans={plans}
            planNote={(item) => planNote(task, item)}
            wire={wire}
          />
        )}
      </div>
    </section>
  )
}
