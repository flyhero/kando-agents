import { useEffect } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { hasPrimaryModifier, PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { SidebarIcon } from './icons'

export function toggleSidebar(): void {
  setPreference('sidebarHidden', !usePreferences.getState().sidebarHidden)
}

// The app's name and the sidebar's switch, in the title bar beside the traffic lights. It stays
// put whether the sidebar shows or not, so the switch is always where it was.
export function WindowBrand() {
  const hidden = usePreferences((s) => s.sidebarHidden)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasPrimaryModifier(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const label = hidden ? '展开侧边栏' : '收起侧边栏'
  return (
    <div className="window-brand">
      <span className="window-brand-name">Kando</span>
      <button
        type="button"
        className="icon-button window-brand-toggle"
        aria-label={label}
        aria-pressed={!hidden}
        data-tooltip={`${label}（${PRIMARY_KEY_LABEL}B）`}
        data-tooltip-align="start"
        onClick={toggleSidebar}
      >
        <SidebarIcon />
      </button>
    </div>
  )
}
