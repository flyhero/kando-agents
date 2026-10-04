import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STEP, sidebarMaxWidth } from '../sidebar-width'

// The lists down the window's left. Its right edge drags to resize it between the limits in
// sidebar-width.ts, the arrow keys nudge it, and a double-click puts it back. While dragging only
// this element re-renders (the lists come in as children); the width is saved on release.
export function Sidebar({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const saved = usePreferences((p) => p.sidebarWidth)
  const [dragged, setDragged] = useState<number | null>(null)
  const sidebar = useRef<HTMLDivElement>(null)
  // Where on the edge it was grabbed, so a click without a move leaves the width as it is.
  const grab = useRef(0)
  const width = dragged ?? saved
  const dragging = dragged !== null
  // What shows: a small window caps the saved width (styles.css does the same as it resizes).
  const shown = clampSidebarWidth(width, window.innerWidth)

  useEffect(() => {
    if (!dragging) {
      return
    }
    document.body.classList.add('side-panel-resizing')
    return () => document.body.classList.remove('side-panel-resizing')
  }, [dragging])

  const pointerOffset = (event: PointerEvent<HTMLDivElement>) => event.clientX - (sidebar.current?.getBoundingClientRect().left ?? 0)
  const commit = () => {
    if (dragged !== null) {
      setPreference('sidebarWidth', dragged)
    }
    setDragged(null)
  }
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commit()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft' ? shown - SIDEBAR_WIDTH_STEP :
      event.key === 'ArrowRight' ? shown + SIDEBAR_WIDTH_STEP :
      event.key === 'Home' ? MIN_SIDEBAR_WIDTH :
      event.key === 'End' ? sidebarMaxWidth(window.innerWidth) :
      null
    if (next === null) {
      return
    }
    event.preventDefault()
    setPreference('sidebarWidth', clampSidebarWidth(next, window.innerWidth))
  }

  return (
    <div ref={sidebar} className="sidebar" hidden={hidden} style={{ '--sidebar-width': `${width}px` }}>
      {children}
      <div
        className="sidebar-resizer"
        data-dragging={dragging}
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={sidebarMaxWidth(window.innerWidth)}
        aria-valuenow={shown}
        aria-valuetext={`侧边栏宽 ${shown} 像素`}
        title="拖动调整宽度，双击恢复默认"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => setPreference('sidebarWidth', DEFAULT_SIDEBAR_WIDTH)}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return
          }
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          grab.current = pointerOffset(event) - shown
          setDragged(shown)
        }}
        onPointerMove={(event) => dragging && setDragged(clampSidebarWidth(pointerOffset(event) - grab.current, window.innerWidth))}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={commit}
      />
    </div>
  )
}
