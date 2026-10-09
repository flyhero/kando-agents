import { useEffect } from 'react'
import { setBrowserOccluded } from './desktop-bridge'

// The browser's tab is a native view over the page, so nothing drawn here can cover it: while a
// dialog, menu or the settings page is up, main takes the view down. Counted, as several may be.
let covering = 0

function cover(delta: number): void {
  const was = covering > 0
  covering = Math.max(0, covering + delta)
  const is = covering > 0
  if (was !== is) setBrowserOccluded(is)
}

// For anything that draws over the workspace: the view is down while it is mounted and active.
export function useOccludesBrowser(active = true): void {
  useEffect(() => {
    if (!active) return
    cover(1)
    return () => cover(-1)
  }, [active])
}
