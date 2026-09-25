import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronRightIcon } from './icons'

export type MenuPoint = { x: number; y: number }

// Opened from the keyboard (context-menu key, Shift+F10) there is no pointer, so it opens under the row.
export function menuPoint(event: MouseEvent<HTMLElement>): MenuPoint {
  if (event.clientX === 0 && event.clientY === 0) {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: box.left + 12, y: box.bottom }
  }
  return { x: event.clientX, y: event.clientY }
}

const EDGE = 8
const ITEMS = ':scope > [role^="menuitem"]:not(:disabled)'

// The items of whichever menu (or open submenu) holds the focus.
function focusedMenuItems(root: HTMLElement): HTMLElement[] {
  const menu = document.activeElement?.closest<HTMLElement>('[role="menu"]')
  return [...(menu && root.contains(menu) ? menu : root).querySelectorAll<HTMLElement>(ITEMS)]
}

// A menu at a point: the pointer for a right-click, or under a button with `align: 'end'`.
// Portaled to <body> so the sidebar's clipped, scrolling boxes can't cut it off.
export function ContextMenu({ at, align = 'start', trigger, label, onClose, children }: {
  at: MenuPoint
  align?: 'start' | 'end'
  // The button that toggles the menu; pressing it isn't an outside click.
  trigger?: HTMLElement | null
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)
  const [opener] = useState(() => document.activeElement)

  // Flips up or left like a native menu when it would run off the window.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    const x = align === 'end'
      ? Math.min(Math.max(EDGE, at.x - width), clientWidth - width - EDGE)
      : at.x + width > clientWidth - EDGE ? Math.max(EDGE, at.x - width) : at.x
    setPlace({ x, y: at.y + height > clientHeight - EDGE ? Math.max(EDGE, at.y - height) : at.y })
    element.querySelector<HTMLElement>(ITEMS)?.focus()
  }, [at, align])

  useEffect(() => {
    const outside = (event: Event) =>
      !(event.target instanceof Node && (panel.current?.contains(event.target) || trigger?.contains(event.target)))
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event)) onClose()
    }
    const onScroll = (event: Event) => {
      if (outside(event)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (opener instanceof HTMLElement) opener.focus()
        onClose()
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && panel.current) {
        event.preventDefault()
        const items = focusedMenuItems(panel.current)
        const current = items.findIndex((item) => item === document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        items[(current + step + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, opener, trigger])

  return createPortal(
    <div
      className="menu context-menu"
      ref={panel}
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body
  )
}

export function MenuItem({ label, hint, danger, disabled, onSelect }: {
  label: string
  hint?: string | null
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'menu-item menu-item-danger' : 'menu-item'}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="menu-item-title">{label}</span>
      {hint && <span className="menu-item-path">{hint}</span>}
    </button>
  )
}

// A row that opens a menu of its own beside it: on hover, or on click, Enter or → (which also
// move the focus in). ← inside it goes back. The parent decides which one is open.
export function MenuSubmenu({ label, value, open, onOpen, onClose, children }: {
  label: string
  value: string
  open: boolean
  onOpen: () => void
  onClose: () => void
  children: ReactNode
}) {
  const row = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<MenuPoint | null>(null)
  const focusOnOpen = useRef(false)

  const focusInside = () =>
    (panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLElement>(ITEMS))?.focus()

  useLayoutEffect(() => {
    const box = row.current?.getBoundingClientRect()
    const element = panel.current
    if (!open || !box || !element) {
      setPlace(null)
      return
    }
    const { width, height } = element.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    const right = box.right + 4
    setPlace({
      x: right + width > clientWidth - EDGE ? Math.max(EDGE, box.left - width - 4) : right,
      y: Math.max(EDGE, Math.min(box.top - 5, clientHeight - height - EDGE))
    })
  }, [open])

  // Only once placed: until then the panel is hidden, and hidden elements can't take focus.
  useLayoutEffect(() => {
    if (place && focusOnOpen.current) {
      focusOnOpen.current = false
      focusInside()
    }
  }, [place])

  const reveal = () => {
    if (open) {
      focusInside()
    } else {
      focusOnOpen.current = true
      onOpen()
    }
  }

  return (
    <>
      <button
        ref={row}
        type="button"
        role="menuitem"
        className="menu-item"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={onOpen}
        onClick={reveal}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            reveal()
          }
        }}
      >
        <span className="menu-item-title">{label}</span>
        <span className="menu-item-path">{value}</span>
        <ChevronRightIcon />
      </button>
      {open && (
        <div
          ref={panel}
          className="menu submenu"
          role="menu"
          aria-label={label}
          style={place ? { left: place.x, top: place.y } : { visibility: 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              onClose()
              row.current?.focus()
            }
          }}
        >
          {children}
        </div>
      )}
    </>
  )
}

export function MenuRadioItem({ label, checked, onSelect }: { label: string; checked: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="menu-item" onClick={onSelect}>
      <span className="menu-item-title">{label}</span>
      {checked && (
        <span className="menu-check">
          <CheckIcon />
        </span>
      )}
    </button>
  )
}
