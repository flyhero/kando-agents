import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { MAX_SIDE_PANEL_RATIO, MIN_SIDE_PANEL_RATIO, clampSidePanelRatio, sidePanelRatioAtPointer } from './side-panel-size'

// The drag handle between the terminal and a side panel. `ratio` is the panel's share of the
// width the two split; the arrow keys nudge it as well.
export function PanelSeparator({ panelName, ratio, onRatioChange, disabled = false }: {
  panelName: string
  ratio: number
  onRatioChange: (ratio: number) => void
  disabled?: boolean
}) {
  const separator = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) {
      return
    }
    document.body.classList.add('side-panel-resizing')
    return () => document.body.classList.remove('side-panel-resizing')
  }, [dragging])

  const resizeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const element = separator.current
    const container = element?.parentElement
    if (!element || !container) {
      return
    }
    const bounds = container.getBoundingClientRect()
    onRatioChange(sidePanelRatioAtPointer(event.clientX, bounds.left, bounds.width, element.offsetWidth))
  }
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
    if (direction === 0) {
      return
    }
    event.preventDefault()
    onRatioChange(clampSidePanelRatio(ratio + direction * 0.02))
  }

  return (
    <div
      ref={separator}
      className="side-panel-separator"
      data-dragging={dragging}
      data-closing={disabled}
      role="separator"
      aria-label={`调整终端与${panelName}宽度`}
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDE_PANEL_RATIO * 100}
      aria-valuemax={MAX_SIDE_PANEL_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${panelName}占 ${Math.round(ratio * 100)}%`}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) {
          return
        }
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        resizeAtPointer(event)
      }}
      onPointerMove={(event) => dragging && resizeAtPointer(event)}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onLostPointerCapture={() => setDragging(false)}
    />
  )
}
