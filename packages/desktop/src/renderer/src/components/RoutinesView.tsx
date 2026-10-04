import { setAwakeMode, setRoutinesOpen, useCore } from '../core-store'
import { UNATTENDED_LABEL } from '../schedules'
import { CloseIcon } from './icons'
import { RoutinesSection } from './RoutinesSection'
import { SettingsLink } from './SchedulePicker'

// The page of routines: rules that open a conversation on a schedule, each with its runs. Their
// conversations are kept out of the sidebar, so this is where they are found.
export function RoutinesView() {
  const routines = useCore((s) => s.routines)
  const mode = useCore((s) => s.chatSettings?.unattendedMode ?? 'acceptEdits')
  const awake = useCore((s) => s.awake)
  const scheduled = routines.some((routine) => routine.enabled && routine.schedule.kind !== 'manual')
  return (
    <section className="worktrees-page routines-page" aria-label="定时任务">
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>定时任务</h2>
          <p className="muted">
            按时间重复的任务：到点新开一个会话，把指令发给 agent，以「{UNATTENDED_LABEL[mode]}」无人值守地做完，<SettingsLink />。
            做完的运行带未读标记，从规则下面的历史里打开看结果；它开的会话不进左侧的会话列表。
          </p>
          {awake && awake.mode !== 'on' && scheduled && (
            <p className="schedule-warning">
              电脑睡着时到点不会运行，醒来后只补最近错过的一次。
              <button type="button" className="link-button" onClick={() => void setAwakeMode('on')}>改为始终保持唤醒</button>
            </p>
          )}
        </div>
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => setRoutinesOpen(false)}>
          <CloseIcon />
        </button>
      </header>
      <RoutinesSection />
    </section>
  )
}
