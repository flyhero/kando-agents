import { attentionCount, noticesBetween } from './attention'
import { selectConversation, selectTask, setSchedulesOpen, useCore } from './core-store'
import { canNotify, notify, onNotificationClick, setBadge } from './desktop-bridge'
import { usePreferences } from './preferences'
import { routineNoticesBetween } from './routines'
import { scheduleNoticesBetween } from './schedules'

// Tells the user what happened while they were away: a system notification when the window is
// not in front, and the count of what waits on them on the dock icon. Reads the store from
// outside React, so a change is told of once however many views show it.
export function startNotifications(): void {
  if (!canNotify()) return
  let prev = useCore.getState()
  let badge = -1
  useCore.subscribe((next) => {
    if (next.conversations !== prev.conversations || next.tasks !== prev.tasks || next.unseen !== prev.unseen || next.routines !== prev.routines) {
      const count = attentionCount(next)
      if (count !== badge) {
        badge = count
        setBadge(count)
      }
    }
    const away = usePreferences.getState().notifications && !document.hasFocus()
    if (next.conversations !== prev.conversations && away) {
      noticesBetween(prev, next).forEach(notify)
    }
    if (next.schedules !== prev.schedules && away) {
      scheduleNoticesBetween(prev.schedules, next.schedules).forEach(notify)
    }
    if (next.routines !== prev.routines && away) {
      routineNoticesBetween(prev.routines, next.routines).forEach(notify)
    }
    prev = next
  })
  onNotificationClick((target) => {
    if (target.kind === 'task') selectTask(target.id)
    else if (target.kind === 'conversation') selectConversation(target.id)
    else setSchedulesOpen(true)
  })
}
