import { useId, useState, type ReactNode } from 'react'
import { setSettingsOpen, useCore } from '../core-store'
import { fromLocalInput, nextNight, toLocalInput, UNATTENDED_LABEL } from '../schedules'
import { Popover } from './Popover'
import { Segmented } from './SettingsControls'
import { InfoIcon } from './icons'

// How every scheduled run goes, whichever way it was set to start.
const SCHEDULE_RULES = '额度不够时会等它恢复再开始；同一个 Agent 的预约一个接一个运行；电脑睡着时不会运行。'

type When = 'quota' | 'time'

// Where the unattended mode is set.
export function SettingsLink() {
  return <button type="button" className="link-button settings-link" onClick={() => setSettingsOpen(true, 'agents')}>在设置里改</button>
}

// When a run may start: as soon as its agent's quota allows, or not before a time, a night hour
// by default. It waits for the quota either way, and runs with nobody there, which the note says.
export function SchedulePicker({ title, note, children, initial, submitLabel = '预约', align = 'start', onSchedule, onClose }: {
  title: string
  // 'end' for a trigger at the end of a row: the picker's right edge on the trigger's.
  align?: 'start' | 'end'
  note?: ReactNode
  // What the run will do, where the caller lets it be written here: under the note, above when.
  children?: ReactNode
  // The time already picked, when changing one; undefined for a new run.
  initial?: number | null
  submitLabel?: string
  onSchedule: (notBefore: number | null) => Promise<boolean>
  onClose: () => void
}) {
  const labelId = useId()
  const mode = useCore((s) => s.chatSettings?.unattendedMode ?? 'acceptEdits')
  const [when, setWhen] = useState<When>(initial ? 'time' : 'quota')
  const [time, setTime] = useState(() => toLocalInput(initial ?? nextNight(Date.now())))
  const [busy, setBusy] = useState(false)
  const notBefore = when === 'time' ? fromLocalInput(time) : null
  const invalid = when === 'time' && notBefore === null
  const submit = async () => {
    if (busy || invalid) return
    setBusy(true)
    const done = await onSchedule(notBefore)
    setBusy(false)
    if (done) onClose()
  }
  return (
    <Popover label={title} onClose={onClose} align={align}>
      <div className="note-form schedule-picker">
        <p className="note-form-title" id={labelId}>{title}</p>
        {note && <p className="menu-note">{note}</p>}
        {children}
        <Segmented<When>
          labelId={labelId}
          value={when}
          onChange={setWhen}
          options={[{ value: 'quota', label: '额度恢复后' }, { value: 'time', label: '指定时间' }]}
        />
        {when === 'time' && (
          <input
            type="datetime-local"
            className="input"
            aria-label="不早于"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        )}
        {/* How it runs, in a line; the rest of how scheduling works waits behind the icon. */}
        <p className="menu-note schedule-picker-mode">
          以「{UNATTENDED_LABEL[mode]}」无人值守运行 · <SettingsLink />
          <span
            className="schedule-picker-info"
            tabIndex={0}
            aria-label={SCHEDULE_RULES}
            data-tooltip={SCHEDULE_RULES}
            data-tooltip-side="top-end"
          >
            <InfoIcon />
          </span>
        </p>
        <div className="note-form-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button type="button" className="button primary" disabled={busy || invalid} onClick={() => void submit()}>{submitLabel}</button>
        </div>
      </div>
    </Popover>
  )
}
