import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

// A non-modal panel under its trigger. It must sit inside the same parent as the
// trigger (a `.menu-anchor`), so a click on the trigger is not an outside click. `floating` places
// it against the window instead, for a trigger inside a box that clips what runs past it.
export function Popover({ label, onClose, floating = false, children }: { label: string; onClose: () => void; floating?: boolean; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = panel.current
    const anchor = element?.parentElement?.getBoundingClientRect()
    if (floating && element && anchor) {
      // Under the trigger, or over it where the window has no room below; its right edge on the
      // trigger's, as for a trigger at the end of a row, unless that would run off the left.
      const { width, height } = element.getBoundingClientRect()
      const { clientHeight } = document.documentElement
      const left = anchor.right - width >= 8 ? anchor.right - width : anchor.left
      const below = anchor.bottom + 4
      const top = below + height > clientHeight - 8 && anchor.top - 4 - height >= 8 ? anchor.top - 4 - height : below
      Object.assign(element.style, { position: 'fixed', left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px`, right: 'auto', bottom: 'auto' })
      element.querySelector<HTMLElement>('input, textarea, button')?.focus()
      return
    }
    const box = element?.getBoundingClientRect()
    // Flip when the trigger sits too close to the right or bottom edge.
    if (element && box && box.right > document.documentElement.clientWidth - 8) {
      element.classList.add('menu-end')
    }
    if (element && box && box.bottom > document.documentElement.clientHeight - 8 && box.top > box.height + 8) {
      element.classList.add('menu-up')
    }
    element?.querySelector<HTMLElement>('input, textarea, button')?.focus()
  }, [])

  useEffect(() => {
    const anchor = panel.current?.parentElement
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor?.contains(event.target)) {
        onClose()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Inside a modal dialog, Escape should close only this panel.
        event.preventDefault()
        anchor?.querySelector<HTMLElement>('[aria-haspopup]')?.focus()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="menu" ref={panel} role="dialog" aria-label={label}>
      {children}
    </div>
  )
}
