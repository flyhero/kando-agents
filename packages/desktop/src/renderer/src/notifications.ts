import { attentionCount, noticesBetween } from './attention'
import { selectConversation, selectTask, setRoutinesOpen, useCore } from './core-store'
import { canNotify, canShowRequestPopup, notify, onNotificationClick, setBadge, wantRequestPopup } from './desktop-bridge'
import { usePreferences } from './preferences'
import { newlyWaiting } from './request-popup'
import { routineNoticesBetween } from './routines'
import { scheduleNoticesBetween } from './schedules'

// Tells the user what happened while they were away: a system notification when the window is
// not in front, and the count of what waits on them on the dock icon; an agent held up on them,
// on the card at the top of the screen (request-popup.ts) when that is on. Reads the store from
// outside React, so a change is told of once however many views show it.
export function startNotifications(): void {
  startRequestPopup()
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
      noticesBetween(prev, next, !popupOn()).forEach(notify)
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
    else setRoutinesOpen(true)
  })
}

const popupOn = () => canShowRequestPopup() && usePreferences.getState().requestPopup

// The card comes up for a request that arrives while the user is elsewhere, and goes when the
// setting is turned off; main puts it away when the window is back in front.
function startRequestPopup(): void {
  if (!canShowRequestPopup()) return
  useCore.subscribe((next, prev) => {
    if (next.conversations !== prev.conversations && popupOn() && !document.hasFocus() && newlyWaiting(prev.conversations, next.conversations)) {
      wantRequestPopup(true)
    }
  })
  usePreferences.subscribe((next, prev) => {
    if (prev.requestPopup && !next.requestPopup) wantRequestPopup(false)
  })
}
