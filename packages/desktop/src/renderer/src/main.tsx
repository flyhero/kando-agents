import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { startAppearance } from './appearance'
import { followRequestPopupWanted, RequestPopup } from './components/RequestPopup'
import { startCoreConnection } from './core-store'
import { applyTitleBar } from './desktop-bridge'
import { startNotifications } from './notifications'
import { followPreferences } from './preferences'
import { startUnsavedEditRetries } from './unsaved-edits'
import { startWorktreeUpdates } from './worktree-store'

// The card of waiting requests (main's request-popup.ts) is this page too, with only what it needs:
// the main window alone tells the user things, counts on the dock and keeps worktrees current.
const popup = location.hash === '#request-popup'

// Outside React so StrictMode's double-mount can't start two loops.
if (popup) {
  document.documentElement.dataset.window = 'request-popup'
  followRequestPopupWanted()
  startCoreConnection('requests')
  startAppearance()
  followPreferences()
} else {
  startCoreConnection()
  startAppearance()
  applyTitleBar()
  startUnsavedEditRetries()
  startWorktreeUpdates()
  startNotifications()
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}
createRoot(root).render(
  <StrictMode>
    {popup ? <RequestPopup /> : <App />}
  </StrictMode>
)
