import { useCallback, useState, type ReactElement } from 'react'
import { checkContinue, checkMove, checkRefine, checkRun, isFinished, manualMoves, shortTaskId, type Task, type TaskStatus } from '@kando/protocol'
import { perform, selectTask, showView, updateTask, useCore, type TaskView } from '../core-store'
import { reasonText } from '../labels'
import { usePreferences } from '../preferences'
import { AgentPicker } from './AgentPicker'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ChatIcon, CheckIcon, CloseIcon, DocumentIcon, MoreIcon, PlayIcon, ReopenIcon, TerminalIcon } from './icons'
import { Popover } from './Popover'

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

// Hand the pane to the agent's terminal, as long as the user is still on this task.
function showTerminalFor(taskId: string): void {
  if (useCore.getState().selectedId === taskId) {
    showView('terminal')
  }
}

async function runTask(taskId: string): Promise<void> {
  const started = await perform((rpc) => rpc.call('tasks.run', { id: taskId }))
  if (started && usePreferences.getState().openTerminalOnRun) {
    showTerminalFor(taskId)
  }
}

async function continueTask(taskId: string, note?: string): Promise<boolean> {
  const started = await perform((rpc) => rpc.call('tasks.continue', { id: taskId, note }))
  if (started && usePreferences.getState().openTerminalOnRun) {
    showTerminalFor(taskId)
  }
  return started !== null
}

const continueLabel = (task: Task) => (task.status === 'review' ? '继续修改' : '继续执行')

// Deleting stops a live agent, so it asks first. Worktrees stay on disk either way.
async function deleteTask(task: Task): Promise<void> {
  const live = task.status === 'running' || task.refineSessionId !== null
  if (window.confirm(`删除任务「${task.title}」？${live ? '正在运行的 agent 会被停止，' : ''}已有的 worktree 会保留。`)) {
    await perform((rpc) => rpc.call('tasks.delete', { id: task.id }))
  }
}

function copyTaskId(taskId: string): void {
  void navigator.clipboard.writeText(taskId).catch(() => {})
}

function unfinished(dependencies: readonly Task[]): Task[] {
  return dependencies.filter((dependency) => dependency.status !== 'done')
}

function RunButton({ task, dependencies }: { task: Task; dependencies: readonly Task[] }) {
  const blocker = checkRun(task, dependencies)
  return (
    <LaunchButton
      label="交给 agent 执行"
      className="run-button"
      Icon={PlayIcon}
      reason={blocker && blockerText(blocker, unfinished(dependencies))}
      launch={() => runTask(task.id)}
    />
  )
}

// Continuing asks for an optional note: under review, what the user found wrong. Under review
// accepting is the main action, so continuing steps back from the run colour.
function ContinueButton({ task, dependencies }: { task: Task; dependencies: readonly Task[] }) {
  const blocker = checkContinue(task, dependencies)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const label = continueLabel(task)
  const className = task.status === 'review' ? '' : 'run-button'
  if (blocker) {
    return (
      <LaunchButton
        label={label}
        className={className}
        Icon={PlayIcon}
        reason={blockerText(blocker, unfinished(dependencies))}
        launch={async () => {}}
      />
    )
  }
  const submit = async () => {
    setBusy(true)
    const started = await continueTask(task.id, note.trim() || undefined)
    setBusy(false)
    if (started) {
      setNote('')
      close()
    }
  }
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className={`tool-button launch-button ${className}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={`${label}：在原来的 worktree 和分支上开一个新会话`}
        onClick={() => setOpen((current) => !current)}
      >
        <PlayIcon />
      </button>
      {open && (
        <Popover label={label} onClose={close}>
          <div className="note-form">
            <p className="note-form-title">{label}</p>
            <p className="menu-note">在原来的 worktree 和分支上开一个新会话，agent 能看到上次的改动。</p>
            <textarea
              className="input note-form-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={task.status === 'review' ? '验收时发现哪里要改？（可选，会告诉继续执行的 agent）' : '这次要改什么？（可选，会告诉继续执行的 agent）'}
              maxLength={2000}
              rows={3}
            />
            <div className="note-form-actions">
              <button type="button" className="button ghost" onClick={close}>
                取消
              </button>
              <button type="button" className="button primary" disabled={busy} onClick={() => void submit()}>
                {label}
              </button>
            </div>
          </div>
        </Popover>
      )}
    </span>
  )
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
              placeholder="为什么废弃？（可选，会告诉重做的 agent）"
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

// While the session is open the button just returns to that conversation.
function RefineButton({ task }: { task: Task }) {
  if (task.refineSessionId) {
    return (
      <button
        type="button"
        className="tool-button refine-button"
        aria-pressed="true"
        aria-label="细化中，查看对话"
        data-tooltip="细化中，查看对话"
        onClick={() => showView('terminal')}
      >
        <ChatIcon />
      </button>
    )
  }
  const blocker = checkRefine(task)
  return (
    <LaunchButton
      label="和 agent 细化任务"
      className="refine-button"
      Icon={ChatIcon}
      reason={blocker && reasonText(blocker, blocker)}
      launch={async () => {
        // A conversation only happens in the terminal, whatever the run preference says.
        if (await perform((rpc) => rpc.call('tasks.refine', { id: task.id }))) {
          showTerminalFor(task.id)
        }
      }}
    />
  )
}

function MoreMenu({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
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

function ViewToggle({ view }: { view: TaskView }) {
  const next = view === 'terminal' ? 'detail' : 'terminal'
  const label = next === 'terminal' ? '查看终端' : '查看详情'
  return (
    <button type="button" className="tool-button" aria-label={label} data-tooltip={label} onClick={() => showView(next)}>
      {next === 'terminal' ? <TerminalIcon /> : <DocumentIcon />}
    </button>
  )
}

// One toolbar for both panes of a task, so its controls never move when switching.
export function TaskToolbar({ task, view }: { task: Task; view: TaskView }) {
  const tasks = useCore((s) => s.tasks)
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  return (
    <div className="toolbar">
      <AgentPicker
        agent={task.agent}
        locked={task.status === 'running' || task.status === 'abandoned'}
        onChange={(agent) => void updateTask(task.id, { agent })}
      />
      {task.status === 'pending' && <RefineButton task={task} />}
      {task.status === 'pending' && <RunButton task={task} dependencies={dependencies} />}
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
      {isFinished(task.status) && <ContinueButton task={task} dependencies={dependencies} />}
      {isFinished(task.status) && <RedoButton task={task} />}
      {(task.sessionId || task.refineSessionId) && <ViewToggle view={view} />}
      <MoreMenu task={task} />
      <span className="toolbar-separator" aria-hidden="true" />
      <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => selectTask(null)}>
        <CloseIcon />
      </button>
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
  const runBlocker = task.status === 'pending' ? checkRun(task, dependencies) : null
  const continueBlocker = isFinished(task.status) ? checkContinue(task, dependencies) : null
  const actions: ReactElement[] = []
  if (task.status === 'pending') {
    actions.push(
      <MenuItem key="run" label="交给 agent 执行" hint={hint(runBlocker)} disabled={runBlocker !== null} onSelect={pick(() => void runTask(task.id))} />
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
  if (isFinished(task.status)) {
    actions.push(
      <MenuItem key="continue" label={continueLabel(task)} hint={hint(continueBlocker)} disabled={continueBlocker !== null} onSelect={pick(() => void continueTask(task.id))} />
    )
  }
  if (task.sessionId || task.refineSessionId) {
    actions.push(
      <MenuItem
        key="terminal"
        label="查看终端"
        onSelect={pick(() => {
          selectTask(task.id)
          showView('terminal')
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
      <div className="menu-separator" role="separator" />
      <MenuItem label="删除任务" danger onSelect={pick(() => void deleteTask(task))} />
    </ContextMenu>
  )
}
