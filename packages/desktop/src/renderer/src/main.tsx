import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { startAppearance } from './appearance'
import { startCoreConnection } from './core-store'
import { applyTitleBar } from './desktop-bridge'
import { startUnsavedEditRetries } from './unsaved-edits'

// Outside React so StrictMode's double-mount can't start two loops.
startCoreConnection()
startAppearance()
applyTitleBar()
startUnsavedEditRetries()

const root = document.getElementById('root')
if (!root) {
  throw new Error('missing #root')
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
