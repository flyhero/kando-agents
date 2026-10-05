import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { UTILITY_PANEL_NAME, visibleUtilityPanelOrder, type UtilityPanelKind, type UtilityPanelsOpen } from '../utility-panel-order'
import { BrowserSidePanel } from './BrowserSidePanel'
import { PanelSeparator } from './PanelSeparator'
import {
  DEFAULT_UTILITY_PANEL_RATIO,
  DEFAULT_STACKED_PANEL_RATIO,
  MAX_STACKED_PANEL_RATIO,
  MIN_STACKED_PANEL_RATIO,
  clampStackedPanelRatio,
  stackedPanelRatioAtPointer
} from './side-panel-size'
import { TerminalPanel } from './TerminalPanel'
import { PortsPanel } from './PortsPanel'

function StackedPanelSeparator({ ratio, upperPanel, lowerPanel, onRatioChange }: {
  ratio: number
  upperPanel: UtilityPanelKind
  lowerPanel: UtilityPanelKind
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
      aria-label={`调整${UTILITY_PANEL_NAME[upperPanel]}和${UTILITY_PANEL_NAME[lowerPanel]}高度`}
      aria-orientation="horizontal"
      aria-valuemin={MIN_STACKED_PANEL_RATIO * 100}
      aria-valuemax={MAX_STACKED_PANEL_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${UTILITY_PANEL_NAME[upperPanel]}占 ${Math.round(ratio * 100)}%`}
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

// Browser, terminal and ports share one right-hand dock, two at most, the one opened first above.
// A maximized one shows alone.
export function UtilityPanelDock({ open, maximized, order }: {
  open: UtilityPanelsOpen
  maximized?: UtilityPanelKind
  order: readonly UtilityPanelKind[]
}) {
  const [widthRatio, setWidthRatio] = useState(DEFAULT_UTILITY_PANEL_RATIO)
  const [upperRatio, setUpperRatio] = useState(DEFAULT_STACKED_PANEL_RATIO)
  const visibleOrder = visibleUtilityPanelOrder(order, open).filter((panel) => !maximized || panel === maximized)
  const [upperPanel = 'browser', lowerPanel = 'terminal'] = visibleOrder
  const stacked = visibleOrder.length > 1
  const rows = stacked
    ? `${upperRatio}fr var(--stacked-panel-separator-size) ${1 - upperRatio}fr`
    : 'minmax(0, 1fr)'

  return (
    <>
      {!maximized && (
        <PanelSeparator
          panelName={stacked ? `${UTILITY_PANEL_NAME[upperPanel]}与${UTILITY_PANEL_NAME[lowerPanel]}工具栏` : `${UTILITY_PANEL_NAME[upperPanel]}栏`}
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
        {visibleOrder.map((panel, index) => (
          <Fragment key={panel}>
            {index > 0 && (
              <StackedPanelSeparator
                ratio={upperRatio}
                upperPanel={upperPanel}
                lowerPanel={lowerPanel}
                onRatioChange={setUpperRatio}
              />
            )}
            {panel === 'browser' ? <BrowserSidePanel /> : panel === 'terminal' ? <TerminalPanel /> : <PortsPanel />}
          </Fragment>
        ))}
      </section>
    </>
  )
}
