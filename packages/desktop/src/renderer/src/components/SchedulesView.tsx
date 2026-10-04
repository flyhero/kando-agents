import { useCallback, useState } from 'react'
import type { ScheduledRun } from '@kando/protocol'
import { selectConversation, selectTask, setAwakeMode, setSchedulesOpen, showView, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { cancelSchedule, clearSchedules, openRuns, reorderSchedules, rescheduleRun, runAction, runScheduleNow, scheduleState, TARGET_LABEL, UNATTENDED_LABEL } from '../schedules'
import { ArrowDownIcon, ArrowUpIcon, ClockIcon, CloseIcon, PlayIcon } from './icons'
import { SchedulePicker, SettingsLink } from './SchedulePicker'

// A task's chat is reached through its task, which the list of free conversations does not hold.
function openTarget(run: ScheduledRun): void {
  const { target } = run
  if (target.kind === 'task') {
    selectTask(target.taskId)
    return
  }
  // A routine's run has a conversation only once it has started.
  const conversationId = target.kind === 'routine' ? run.conversationId : target.conversationId
  if (!conversationId) return
  const { conversations, tasks } = useCore.getState()
  const owner = Object.values(tasks).find((task) => task.conversationId === conversationId)
  if (owner) {
    selectTask(owner.id)
    showView('chat')
  } else if (conversations[conversationId]) {
    selectConversation(conversationId)
  }
}

function Reschedule({ run }: { run: ScheduledRun }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor">
      <button type="button" className="tool-button" aria-label="改时间" data-tooltip="改时间" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ClockIcon />
      </button>
      {open && (
        <SchedulePicker
          title="改预约时间"
          initial={run.notBefore}
          submitLabel="保存"
          onSchedule={async (notBefore) => (await rescheduleRun(run.id, notBefore)) !== null}
          onClose={close}
        />
      )}
    </span>
  )
}

function OpenRow({ run, index, count, now, onMove }: { run: ScheduledRun; index: number; count: number; now: number; onMove: (from: number, to: number) => void }) {
  const waiting = run.status === 'waiting'
  return (
    <li className="schedule-row">
      <span className="schedule-index">{index + 1}</span>
      <span className="schedule-main">
        <button type="button" className="schedule-title" onClick={() => openTarget(run)}>{run.title}</button>
        <span className="schedule-meta" title={runAction(run)}>{TARGET_LABEL[run.target.kind]} · {AGENT_LABEL[run.agent]} · {runAction(run)}</span>
      </span>
      <span className="schedule-state">{scheduleState(run, now)}</span>
      <span className="schedule-actions">
        <button type="button" className="tool-button" aria-label="提前" data-tooltip="提前" disabled={index === 0} onClick={() => onMove(index, index - 1)}><ArrowUpIcon /></button>
        <button type="button" className="tool-button" aria-label="推后" data-tooltip="推后" disabled={index === count - 1} onClick={() => onMove(index, index + 1)}><ArrowDownIcon /></button>
        {waiting && run.target.kind !== 'resume' && <Reschedule run={run} />}
        {waiting && (
          <button
            type="button"
            className="tool-button"
            aria-label="现在开始"
            data-tooltip="现在开始，不等时间和额度"
            onClick={() => void runScheduleNow(run.id)}
          >
            <PlayIcon />
          </button>
        )}
        {waiting && (
          <button type="button" className="tool-button" aria-label="取消预约" data-tooltip="取消预约" onClick={() => void cancelSchedule(run.id)}>
            <CloseIcon />
          </button>
        )}
      </span>
    </li>
  )
}

function SettledRow({ run, now }: { run: ScheduledRun; now: number }) {
  return (
    <li className="schedule-row" data-status={run.status}>
      <span className="schedule-index" />
      <span className="schedule-main">
        <button type="button" className="schedule-title" onClick={() => openTarget(run)}>{run.title}</button>
        <span className="schedule-meta" title={runAction(run)}>{TARGET_LABEL[run.target.kind]} · {AGENT_LABEL[run.agent]} · {runAction(run)}</span>
      </span>
      <span className="schedule-state" data-warn={run.status === 'failed' || undefined}>{scheduleState(run, now)}</span>
      <span className="schedule-actions" />
    </li>
  )
}

// Every run scheduled to start later, in the order they go, then what became of the recent ones.
export function SchedulesView() {
  const runs = useCore((s) => s.schedules)
  const mode = useCore((s) => s.chatSettings?.unattendedMode ?? 'acceptEdits')
  const awake = useCore((s) => s.awake)
  const open = openRuns(runs)
  const settled = runs.filter((run) => !open.includes(run))
  const now = Date.now()
  const move = (from: number, to: number) => {
    const ids = open.map((run) => run.id)
    const [moved] = ids.splice(from, 1)
    if (moved === undefined) return
    ids.splice(to, 0, moved)
    reorderSchedules(ids)
  }
  return (
    <section className="worktrees-page schedules-page" aria-label="预约">
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>预约</h2>
          <p className="muted">
            到点、而且 agent 的额度够用时自动开始；同一个 agent 的预约按下面的顺序一个接一个运行。
            你预约的以「{UNATTENDED_LABEL[mode]}」无人值守运行，<SettingsLink />；撞到额度后的续跑沿用会话原来的模式。
          </p>
          {awake?.mode === 'off' && open.length > 0 && (
            <p className="schedule-warning">
              「保持电脑唤醒」已关闭，电脑睡着时预约不会运行。
              <button type="button" className="link-button" onClick={() => void setAwakeMode('auto')}>改为有预约时保持唤醒</button>
            </p>
          )}
        </div>
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => setSchedulesOpen(false)}>
          <CloseIcon />
        </button>
      </header>
      <section className="worktree-group" aria-label="等待中">
        <h3 className="worktree-group-title">等待中 · {open.length}</h3>
        {open.length === 0
          ? <p className="worktrees-empty muted">没有等待中的预约。在任务的工具栏或聊天输入框旁点时钟图标预约。</p>
          : <ul className="worktree-list">{open.map((run, index) => <OpenRow key={run.id} run={run} index={index} count={open.length} now={now} onMove={move} />)}</ul>}
      </section>
      {settled.length > 0 && (
        <section className="worktree-group" aria-label="最近">
          <h3 className="worktree-group-title">
            最近 · {settled.length}
            <button type="button" className="link-button" onClick={clearSchedules}>清除记录</button>
          </h3>
          <ul className="worktree-list">{settled.map((run) => <SettledRow key={run.id} run={run} now={now} />)}</ul>
        </section>
      )}
    </section>
  )
}
