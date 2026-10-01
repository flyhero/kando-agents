import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { BrowserSidePanel } from './BrowserSidePanel'
import { PanelSeparator } from './PanelSeparator'
import {
  DEFAULT_SIDE_PANEL_RATIO,
  DEFAULT_STACKED_PANEL_RATIO,
  MAX_STACKED_PANEL_RATIO,
  MIN_STACKED_PANEL_RATIO,
  clampStackedPanelRatio,
  stackedPanelRatioAtPointer
} from './side-panel-size'
import { TerminalPanel } from './TerminalPanel'

type UtilityKind = 'browser' | 'terminal'

function StackedPanelSeparator({ ratio, onRatioChange }: {
  ratio: number
  onRatioChange: (ratio: number) => void
}) {
  const separator = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('stacked-panel-resizing')
    return () => document.body.classList.remove('stacked-panel-resizing')
  }, [dragging])

  const resizeAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const element = separator.current
    const container = element?.parentElement
    if (!element || !container) return
    const bounds = container.getBoundingClientRect()
    onRatioChange(stackedPanelRatioAtPointer(event.clientY, bounds.top, bounds.height, element.offsetHeight))
  }
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (direction === 0) return
    event.preventDefault()
    onRatioChange(clampStackedPanelRatio(ratio + direction * 0.02))
  }

  return (
    <div
      ref={separator}
      className="stacked-panel-separator"
      data-dragging={dragging || undefined}
      role="separator"
      aria-label="调整浏览器和终端高度"
      aria-orientation="horizontal"
      aria-valuemin={MIN_STACKED_PANEL_RATIO * 100}
      aria-valuemax={MAX_STACKED_PANEL_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`浏览器占 ${Math.round(ratio * 100)}%`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return
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

// Browser and terminal share one right-hand dock. When both are open they stack vertically, so
// opening a second tool never creates a third workspace column.
export function UtilityPanelDock({ browserOpen, terminalOpen, maximized }: {
  browserOpen: boolean
  terminalOpen: boolean
  maximized?: UtilityKind
}) {
  const [widthRatio, setWidthRatio] = useState(DEFAULT_SIDE_PANEL_RATIO)
  const [browserRatio, setBrowserRatio] = useState(DEFAULT_STACKED_PANEL_RATIO)
  const showBrowser = browserOpen && (!maximized || maximized === 'browser')
  const showTerminal = terminalOpen && (!maximized || maximized === 'terminal')
  const stacked = showBrowser && showTerminal
  const rows = stacked
    ? `${browserRatio}fr var(--stacked-panel-separator-size) ${1 - browserRatio}fr`
    : 'minmax(0, 1fr)'

  return (
    <>
      {!maximized && (
        <PanelSeparator
          panelName={stacked ? '浏览器与终端工具栏' : showBrowser ? '浏览器栏' : '终端栏'}
          ratio={widthRatio}
          onRatioChange={setWidthRatio}
        />
      )}
      <section
        className="utility-panel-dock"
        aria-label="工具栏"
        data-maximized={maximized || undefined}
        data-stacked={stacked || undefined}
        style={{
          flexBasis: maximized ? undefined : `calc((100% - var(--side-panel-separator-size)) * ${widthRatio})`,
          gridTemplateRows: rows
        }}
      >
        {showBrowser && <BrowserSidePanel />}
        {stacked && <StackedPanelSeparator ratio={browserRatio} onRatioChange={setBrowserRatio} />}
        {showTerminal && <TerminalPanel />}
      </section>
    </>
  )
}
