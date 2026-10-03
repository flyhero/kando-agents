import { attentionCount, noticesBetween } from './attention'
import { selectConversation, selectTask, useCore } from './core-store'
import { canNotify, notify, onNotificationClick, setBadge } from './desktop-bridge'
import { usePreferences } from './preferences'
import { scheduleNoticesBetween } from './schedules'

// Tells the user what happened while they were away: a system notification when the window is
// not in front, and the count of what waits on them on the dock icon. Reads the store from
// outside React, so a change is told of once however many views show it.
export function startNotifications(): void {
  if (!canNotify()) return
  let prev = useCore.getState()
  let badge = -1
  useCore.subscribe((next) => {
    if (next.conversations !== prev.conversations || next.tasks !== prev.tasks || next.unseen !== prev.unseen) {
      const count = attentionCount(next)
      if (count !== badge) {
        badge = count
        setBadge(count)
      }
    }
    if (next.conversations !== prev.conversations && usePreferences.getState().notifications && !document.hasFocus()) {
      noticesBetween(prev, next).forEach(notify)
    }
    if (next.schedules !== prev.schedules && usePreferences.getState().notifications && !document.hasFocus()) {
      scheduleNoticesBetween(prev.schedules, next.schedules).forEach(notify)
    }
    prev = next
  })
  onNotificationClick((target) => {
    if (target.kind === 'task') selectTask(target.id)
    else selectConversation(target.id)
  })
}
