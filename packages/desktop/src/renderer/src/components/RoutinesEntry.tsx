import { setSchedulesOpen, useCore, useRoutinesSupported } from '../core-store'
import { ClockIcon } from './icons'

// The way to the routines, at the top of the sidebar with the dashboard: their conversations are
// kept out of the list below, so this is where their runs are found, with how many are unread.
// Gone on a core without routines.
export function RoutinesEntry() {
  const open = useCore((s) => s.schedulesOpen)
  const unread = useCore((s) => s.routines.reduce((sum, routine) => sum + routine.unread, 0))
  const supported = useRoutinesSupported()
  if (!supported) return null
  return (
    <button type="button" className="inbox-entry sidebar-routines" aria-current={open} onClick={() => setSchedulesOpen(true)}>
      <ClockIcon />
      <span>定时任务</span>
      {unread > 0 && <span className="inbox-entry-count" aria-label={`${unread} 次运行未看`}>{unread}</span>}
    </button>
  )
}
