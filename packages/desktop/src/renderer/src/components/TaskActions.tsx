import { useCallback, useState, type ReactElement } from 'react'
import {
  checkMove,
  checkScheduleTask,
  checkStart,
  checkSubmit,
  isFinished,
  manualMoves,
  shortTaskId,
  startKind,
  type Task,
  type TaskStatus
} from '@kando/protocol'
import { perform, selectTask, setInspectorOpen, setSchedulesOpen, showTaskChanges, showView, updateTask, useChatOptionsSupported, useCore, useSchedulesSupported, useWireLogShown, useWorktreesSupported, type TaskView } from '../core-store'
import { reasonText } from '../labels'
import { useFileTabs } from '../file-tabs'
import { usePreferences } from '../preferences'
import { AgentPicker } from './AgentPicker'
import { confirmQuota } from './AgentQuota'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ChatIcon, CheckIcon, ClockIcon, CloseIcon, DocumentIcon, InspectorIcon, MoreIcon, PlayIcon, ReopenIcon, SubmitIcon } from './icons'
import { Popover } from './Popover'
import { cleanWithConfirm } from './WorktreeManager'
import { SchedulePicker } from './SchedulePicker'
import { useTaskHandoff, type TaskHandoff } from './TaskHandoff'
import { createSchedule, openRunForTask, scheduleState } from '../schedules'

function blockerText(blocker: string, waitingOn: readonly Task[]): string {
  if (blocker === 'blocked' && waitingOn.length > 0) {
    return `等待${waitingOn.map((dependency) => `「${dependency.title}」${dependency.status === 'review' ? '验收通过' : '完成'}`).join('、')}`
  }
  return reasonText(blocker, blocker)
}

type MoveAction = { label: string; Icon: () => ReactElement; className?: string }

// Manual moves only ever close a task; continuing and redoing have their own buttons.
// Closing a task under review is accepting its result, the step that frees its dependents.
function moveAction(from: TaskStatus, to: TaskStatus): MoveAction | null {
  if (to !== 'done') return null
  return from === 'review' ? { label: '接受', Icon: CheckIcon, className: 'run-button' } : { label: '标记完成', Icon: CheckIcon }
}

async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
  await perform((rpc) => rpc.call('tasks.move', { id: taskId, status }))
}

function moveBlocker(task: Task, status: TaskStatus): string | null {
  const blocker = checkMove(task, status)
  return blocker && reasonText(blocker, blocker)
}

// Looks disabled while blocked but still answers a click with the reason:
// a dead button that never says why is the confusing kind.
function LaunchButton({
  label,
  className,
  Icon,
  reason,
  launch
}: {
  label: string
  className?: string
  Icon: () => ReactElement
  reason: string | null
  launch: () => Promise<void>
}) {
  const [explaining, setExplaining] = useState(false)
  const [starting, setStarting] = useState(false)
  const close = useCallback(() => setExplaining(false), [])
  const blocked = reason !== null

  return (
    <span className="menu-anchor">
      <button
        type="button"
        className={`tool-button launch-button ${className ?? ''}`}
        aria-label={label}
        aria-disabled={blocked}
        aria-busy={starting}
        aria-haspopup={blocked ? 'dialog' : undefined}
        aria-expanded={blocked ? explaining : undefined}
        data-tooltip={reason ? `还不能${label}：${reason}` : label}
        onClick={async () => {
          if (blocked) {
            setExplaining((open) => !open)
          } else if (!starting) {
            setStarting(true)
            await launch()
            setStarting(false)
          }
        }}
      >
        <Icon />
      </button>
      {explaining && reason && (
        <Popover label={`还不能${label}`} onClose={close}>
          <p className="menu-note">
            还不能{label}：{reason}
          </p>
        </Popover>
      )}
    </span>
  )
}

// Hand the pane to the task's chat, as long as the user is still on this task.
function showChatFor(taskId: string): void {
  if (useCore.getState().selectedId === taskId) {
    showView('chat')
  }
}

function bypassOption(bypassable: boolean): { allowBypass?: boolean } {
  return bypassable ? { allowBypass: usePreferences.getState().allowBypass } : {}
}

// A task's agent with its quota used up would stall at once; the user decides.
function quotaAllows(taskId: string): boolean {
  const agent = useCore.getState().tasks[taskId]?.agent
  return !agent || confirmQuota(agent)
}

// Both the toolbar and context menu open the same launch configuration.
async function startTask(taskId: string): Promise<void> {
  useCore.setState({ taskLaunchId: taskId })
}

async function submitTask(taskId: string): Promise<void> {
  if (await perform((rpc) => rpc.call('tasks.submit', { id: taskId }))) {
    showTaskChanges()
  }
}

// What a chat task's agent is doing, for the rule that it is not handed in mid-turn.
function useChatTurn(task: Task) {
  return useCore((s) => {
    const conversation = task.conversationId ? s.conversations[task.conversationId] : undefined
    return conversation?.sessionId ? (conversation.chat?.turn ?? null) : null
  })
}

// Deleting stops a live agent, so it asks first. Worktrees stay on disk either way.
async function deleteTask(task: Task): Promise<void> {
  if (window.confirm(`删除任务「${task.title}」？${task.status === 'running' ? '正在运行的 agent 会被停止，' : ''}已有的 worktree 会保留。`)) {
    await perform((rpc) => rpc.call('tasks.delete', { id: task.id }))
  }
}

function copyTaskId(taskId: string): void {
  void navigator.clipboard.writeText(taskId).catch(() => {})
}

function unfinished(dependencies: readonly Task[]): Task[] {
  return dependencies.filter((dependency) => dependency.status !== 'done')
}

// Redoing gives up this attempt, so it asks first, and takes the reason along to the next one.
function RedoButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const redo = async () => {
    setBusy(true)
    const successor = await perform((rpc) => rpc.call('tasks.redo', { id: task.id, reason: reason.trim() || undefined }))
    setBusy(false)
    if (successor) {
      close()
      selectTask(successor.id)
    }
  }
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button"
        aria-label="重做"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip="重做：废弃这次结果，新建一个继承它的任务"
        onClick={() => setOpen((current) => !current)}
      >
        <ReopenIcon />
      </button>
      {open && (
        <Popover label="重做任务" onClose={close}>
          <div className="note-form">
            <p className="note-form-title">废弃这次结果，从头重做</p>
            <p className="menu-note">
              会新建一个继承标题、详情、项目和依赖的任务，从干净的分支开始。这次的 worktree 会保留，依赖本任务的任务改为依赖新任务。
            </p>
            <textarea
              className="input note-form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="为什么废弃？（可选，会告诉重做的 Agent）"
              maxLength={500}
              rows={3}
            />
            <div className="note-form-actions">
              <button type="button" className="button ghost" onClick={close}>
                取消
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={() => void redo()}>
                废弃并重做
              </button>
            </div>
          </div>
        </Popover>
      )}
    </span>
  )
}

// While a task can only plan and already has a chat, return to it instead of launching again.
function StartButton({ task, dependencies }: { task: Task; dependencies: readonly Task[] }) {
  const blocker = checkStart(task, dependencies)
  if (blocker === 'planning') {
    return (
      <button type="button" className="tool-button run-button" aria-pressed="true" aria-label="规划中，查看对话" data-tooltip="规划中，查看对话" onClick={() => showView('chat')}>
        <ChatIcon />
      </button>
    )
  }
  const plan = startKind(dependencies) === 'plan'
  return (
    <LaunchButton
      label={plan ? '开始规划' : '开始执行'}
      className="run-button"
      Icon={plan ? ChatIcon : PlayIcon}
      reason={blocker && blockerText(blocker, unfinished(dependencies))}
      launch={() => startTask(task.id)}
    />
  )
}

// Carrying the task out later, unattended: once its time comes and its agent has quota again.
// Once scheduled, the button says when and leads to the page of scheduled runs.
function ScheduleButton({ task, dependencies }: { task: Task; dependencies: readonly Task[] }) {
  const supported = useSchedulesSupported() && task.agent !== 'cursor'
  const scheduled = useCore((s) => openRunForTask(s.schedules, task.id))
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  if (!supported) return null
  if (scheduled) {
    const state = scheduleState(scheduled, Date.now())
    return (
      <button type="button" className="tool-button task-scheduled" aria-pressed="true" aria-label={`已预约：${state}`} data-tooltip={`已预约：${state}`} onClick={() => setSchedulesOpen(true)}>
        <ClockIcon />
      </button>
    )
  }
  const blocker = checkScheduleTask(task, dependencies)
  const reason = blocker && blockerText(blocker === 'dependencies-unfinished' ? 'blocked' : blocker, unfinished(dependencies))
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button"
        aria-label="预约执行"
        aria-disabled={reason !== null}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={reason ? `还不能预约：${reason}` : '预约执行：额度恢复后或到点自动开始'}
        onClick={() => setOpen((current) => !current)}
      >
        <ClockIcon />
      </button>
      {open && (reason ? (
        <Popover label="还不能预约" onClose={close}>
          <p className="menu-note">还不能预约：{reason}</p>
        </Popover>
      ) : (
        <SchedulePicker
          title="预约执行"
          note={task.plan ? '到点后按保存的计划直接实现，不再先规划。' : '到点后按任务详情直接实现，不再先规划。'}
          onSchedule={async (notBefore) => (await createSchedule({ kind: 'task', taskId: task.id }, notBefore)) !== null}
          onClose={close}
        />
      ))}
    </span>
  )
}

function SubmitButton({ task }: { task: Task }) {
  const blocker = checkSubmit(task, useChatTurn(task))
  return (
    <LaunchButton
      label="提交验收"
      className="run-button"
      Icon={SubmitIcon}
      reason={blocker && reasonText(blocker, blocker)}
      launch={() => submitTask(task.id)}
    />
  )
}

// A finished task's worktrees can go: their commits stay on the branch, and going on lays them out
// again. Core checks each as it stands; an older core has nothing to clean with.
function useWorktreeCleaning(task: Task): (() => void) | null {
  const supported = useWorktreesSupported()
  const paths = task.repos.flatMap((repo) => (repo.worktreePath ? [repo.worktreePath] : []))
  if (!supported || paths.length === 0 || (task.status !== 'done' && task.status !== 'abandoned')) return null
  return () => void cleanWithConfirm(paths, paths.length > 1 ? `这个任务的 ${paths.length} 个 worktree` : '这个任务的 worktree')
}

function MoreMenu({ task, handoff }: { task: Task; handoff: TaskHandoff }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const clean = useWorktreeCleaning(task)
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button"
        aria-label="更多操作"
        data-tooltip="更多操作"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreIcon />
      </button>
      {open && (
        <Popover label="更多操作" onClose={close}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              copyTaskId(task.id)
            }}
          >
            复制任务 id
            <span className="menu-item-path mono">{shortTaskId(task.id)}…</span>
          </button>
          {handoff.available && (
            <button
              type="button"
              className="menu-item"
              disabled={handoff.blocker !== null}
              title={handoff.blocker ?? undefined}
              onClick={() => {
                close()
                handoff.open()
              }}
            >
              移交给其他智能体…
              {handoff.blocker && <span className="menu-item-path">{handoff.blocker}</span>}
            </button>
          )}
          {clean && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close()
                clean()
              }}
            >
              清理 worktree
              <span className="menu-item-path">分支保留</span>
            </button>
          )}
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item menu-item-danger"
            onClick={() => {
              close()
              void deleteTask(task)
            }}
          >
            删除任务
          </button>
        </Popover>
      )}
    </span>
  )
}

// Between the details and where the agent works.
function ViewToggle({ view }: { view: TaskView }) {
  const next = view === 'chat' ? 'detail' : 'chat'
  const label = next === 'detail' ? '查看详情' : '查看聊天'
  return (
    <button type="button" className="tool-button" aria-label={label} data-tooltip={label} onClick={() => showView(next)}>
      {next === 'detail' ? <DocumentIcon /> : <ChatIcon />}
    </button>
  )
}

// The inspector sits beside the chat, so from the details the button switches over to open it.
function InspectorToggle({ view }: { view: TaskView }) {
  const open = useCore((s) => s.inspectorOpen)
  const pressed = view === 'chat' && open
  return (
    <button
      type="button"
      className="tool-button"
      aria-label="检查器"
      aria-pressed={pressed}
      data-tooltip={pressed ? '收起检查器' : '查看改动'}
      onClick={() => {
        setInspectorOpen(!pressed)
        if (view !== 'chat') showView('chat')
      }}
    >
      <InspectorIcon />
    </button>
  )
}

// One toolbar for both panes of a task, so its controls never move when switching.
export function TaskToolbar({ task, view }: { task: Task; view: TaskView }) {
  const tasks = useCore((s) => s.tasks)
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const worktree = task.repos.some((repo) => repo.worktreePath !== null)
  const hasFiles = useFileTabs((state) => (state[task.conversationId ?? '']?.tabs.length ?? 0) > 0)
  const wire = useWireLogShown()
  const handoff = useTaskHandoff(task)
  // A running task's agent changes only by handing its chat over; otherwise the next start or
  // message takes the new one, which a chat already begun is handed to.
  const handsOff = task.status === 'running' && handoff.available
  return (
    <div className="toolbar">
      <AgentPicker
        agent={task.agent}
        locked={task.status === 'abandoned' || (task.status === 'running' && !handsOff)}
        onChange={(agent) => {
          if (!handsOff) void updateTask(task.id, { agent })
          else if (agent) handoff.open(agent)
        }}
      />
      {task.status === 'pending' && <StartButton task={task} dependencies={dependencies} />}
      {task.status === 'pending' && <ScheduleButton task={task} dependencies={dependencies} />}
      {task.status === 'running' && <SubmitButton task={task} />}
      {manualMoves(task.status).map((status) => {
        const action = moveAction(task.status, status)
        return (
          action && (
            <LaunchButton
              key={status}
              label={action.label}
              className={action.className}
              Icon={action.Icon}
              reason={moveBlocker(task, status)}
              launch={() => moveTask(task.id, status)}
            />
          )
        )
      })}
      {/* A finished task goes on by a message in its chat. */}
      {isFinished(task.status) && <RedoButton task={task} />}
      {task.conversationId && (worktree || wire || hasFiles) && <InspectorToggle view={view} />}
      {task.conversationId && <ViewToggle view={view} />}
      <MoreMenu task={task} handoff={handoff} />
      <span className="toolbar-separator" aria-hidden="true" />
      <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => selectTask(null)}>
        <CloseIcon />
      </button>
      {handoff.dialog}
    </div>
  )
}

// The row's right-click menu: the toolbar's one-step actions, under the same rules.
export function TaskContextMenu({ task, at, onClose, onRename }: {
  task: Task
  at: MenuPoint
  onClose: () => void
  onRename: () => void
}) {
  const tasks = useCore((s) => s.tasks)
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  const hint = (blocker: string | null) => blocker && blockerText(blocker, unfinished(dependencies))
  const bypassable = useChatOptionsSupported()
  const turn = useChatTurn(task)
  const startBlocker = task.status === 'pending' ? checkStart(task, dependencies) : null
  const clean = useWorktreeCleaning(task)
  const actions: ReactElement[] = []
  if (task.status === 'pending' && startBlocker !== 'planning') {
    const label = startKind(dependencies) === 'plan' ? '开始规划' : '开始执行'
    actions.push(
      <MenuItem key="start" label={label} hint={hint(startBlocker)} disabled={startBlocker !== null} onSelect={pick(() => void startTask(task.id))} />
    )
  }
  if (task.status === 'running') {
    const blocker = checkSubmit(task, turn)
    actions.push(
      <MenuItem key="submit" label="提交验收" hint={blocker && reasonText(blocker, blocker)} disabled={blocker !== null} onSelect={pick(() => void submitTask(task.id))} />
    )
  }
  for (const status of manualMoves(task.status)) {
    const action = moveAction(task.status, status)
    const blocker = moveBlocker(task, status)
    if (action) {
      actions.push(
        <MenuItem key={status} label={action.label} hint={blocker} disabled={blocker !== null} onSelect={pick(() => void moveTask(task.id, status))} />
      )
    }
  }
  if (task.conversationId) {
    actions.push(
      <MenuItem
        key="work"
        label="查看聊天"
        onSelect={pick(() => {
          selectTask(task.id)
          showView('chat')
        })}
      />
    )
  }
  return (
    <ContextMenu at={at} label={`任务「${task.title}」的操作`} onClose={onClose}>
      {actions}
      {actions.length > 0 && <div className="menu-separator" role="separator" />}
      <MenuItem label="重命名" onSelect={pick(onRename)} />
      <MenuItem label="复制任务 id" hint={`${shortTaskId(task.id)}…`} onSelect={pick(() => copyTaskId(task.id))} />
      {clean && <MenuItem label="清理 worktree" hint="分支保留" onSelect={pick(clean)} />}
      <div className="menu-separator" role="separator" />
      <MenuItem label="删除任务" danger onSelect={pick(() => void deleteTask(task))} />
    </ContextMenu>
  )
}
