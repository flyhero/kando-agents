import { setBrowserMaximized, toggleBrowserPanel, useCore } from '../core-store'
import { BrowserPanel, BrowserTabStrip } from './BrowserPanel'
import { CloseIcon, MaximizeIcon, RestoreIcon } from './icons'

// Every hosted tab, the agents' and the user's own. The dock decides whether this sits above the
// terminal or fills the available tool area. Hiding it leaves the browser running.
export function BrowserSidePanel() {
  const maximized = useCore((s) => s.browserMaximized)
  return (
    <aside className="side-panel browser-side-panel" aria-label="浏览器" data-maximized={maximized || undefined}>
      <header className="terminal-panel-header browser-side-header">
        <BrowserTabStrip />
        <button
          type="button"
          className="tool-button"
          aria-label={maximized ? '还原' : '最大化'}
          data-tooltip={maximized ? '还原' : '最大化'}
          onClick={() => setBrowserMaximized(!maximized)}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" className="tool-button" aria-label="隐藏浏览器" data-tooltip="隐藏（浏览器继续运行）" onClick={toggleBrowserPanel}>
          <CloseIcon />
        </button>
      </header>
      <BrowserPanel />
    </aside>
  )
}
