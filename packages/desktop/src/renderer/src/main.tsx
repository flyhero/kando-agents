import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
// Geist, for the chat's font setting; the system font needs no file.
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import './styles.css'
import { App } from './App'
import { startAppearance } from './appearance'
import { startCoreConnection } from './core-store'
import { applyTitleBar } from './desktop-bridge'
import { startUnsavedEditRetries } from './unsaved-edits'
import { startWorktreeUpdates } from './worktree-store'

// Outside React so StrictMode's double-mount can't start two loops.
startCoreConnection()
startAppearance()
applyTitleBar()
startUnsavedEditRetries()
startWorktreeUpdates()

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
