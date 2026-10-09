import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { addQuote, useQuotes } from '../chat-quotes'
import { PLAN_SELECTION_MENU, placeCommentBox } from '../plan-comment-place'
import { selectedTextIn, type SelectedText } from '../text-selection'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { CommentAddIcon } from './icons'

// Where each comment's passage lies in the plan, by quote id, for its highlight. A range lasts
// while the plan's text stays rendered; one whose text is gone simply marks nothing.
const passages = new Map<string, Range>()

const DRAFT = 'kando-plan-draft'
const COMMENTED = 'kando-plan-comments'

type SelectionMenu = { at: MenuPoint; text: string }

function containsPoint(range: Range, x: number, y: number): boolean {
  return [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

function mark(name: string, ranges: readonly Range[]): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  if (ranges.length === 0) CSS.highlights.delete(name)
  else CSS.highlights.set(name, new Highlight(...ranges))
}

// Text selected in a plan opens a box to say something about it. Each comment joins the chat's
// quotes: while the plan waits they go back with it to keep planning, otherwise they wait in the
// input like any quote. The passages commented on stay marked in the plan.
export function PlanComments({ conversationId, planKey, body }: { conversationId: string; planKey: string; body: RefObject<HTMLElement | null> }) {
  const [draft, setDraft] = useState<SelectedText | null>(null)
  const [comment, setComment] = useState('')
  const [menu, setMenu] = useState<SelectionMenu | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const menuWasOpen = useRef(false)
  const closeMenu = useCallback(() => setMenu(null), [])
  const quotes = useQuotes(conversationId)

  // A new selection opens the box; with the box open, the focus in it must not close it.
  useEffect(() => {
    const element = body.current
    if (!element || draft) return
    const settle = () => setTimeout(() => {
      const picked = selectedTextIn(element, '.chat-plan-body')
      if (picked) {
        setComment('')
        setDraft(picked)
      }
    }, 0)
    document.addEventListener('mouseup', settle)
    element.addEventListener('keyup', settle)
    return () => {
      document.removeEventListener('mouseup', settle)
      element.removeEventListener('keyup', settle)
    }
  }, [body, draft])

  // The comment input takes focus after a selection, so the browser's live selection may no
  // longer be available on a later right-click. The cloned range still identifies the passage.
  useEffect(() => {
    const element = body.current
    if (!element) return
    const open = (event: MouseEvent) => {
      const selected = selectedTextIn(element, '.chat-plan-body')
      const picked = selected ?? (draft && containsPoint(draft.range, event.clientX, event.clientY) ? draft : null)
      if (!picked) return
      event.preventDefault()
      setMenu({ at: { x: event.clientX, y: event.clientY }, text: picked.text })
    }
    element.addEventListener('contextmenu', open)
    return () => element.removeEventListener('contextmenu', open)
  }, [body, draft])

  useEffect(() => {
    mark(DRAFT, draft ? [draft.range] : [])
    return () => mark(DRAFT, [])
  }, [draft])

  useEffect(() => {
    const live = new Set(quotes.map((quote) => quote.id))
    for (const id of passages.keys()) if (!live.has(id)) passages.delete(id)
    mark(COMMENTED, quotes.flatMap((quote) => {
      const range = quote.source === planKey ? passages.get(quote.id) : undefined
      return range ? [range] : []
    }))
  }, [quotes, planKey])
  useEffect(() => () => mark(COMMENTED, []), [])

  useEffect(() => {
    if (!draft) return
    const close = () => setDraft(null)
    const outside = (event: PointerEvent) => {
      if (event.button === 2 && containsPoint(draft.range, event.clientX, event.clientY)) return
      if (!(event.target instanceof Element && event.target.closest('.plan-comment-box, .context-menu'))) close()
    }
    const element = body.current
    document.addEventListener('pointerdown', outside, true)
    element?.addEventListener('scroll', close)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      element?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
    }
  }, [draft, body])

  // The menu takes focus while it is open. Closing it returns here, with the draft still written.
  useEffect(() => {
    if (menu) {
      menuWasOpen.current = true
      return
    }
    if (!menuWasOpen.current) return
    menuWasOpen.current = false
    input.current?.focus()
  }, [menu])

  const add = () => {
    if (!draft) return
    const id = addQuote(conversationId, planKey, draft.text, comment)
    if (id) passages.set(id, draft.range)
    document.getSelection()?.removeAllRanges()
    setDraft(null)
  }
  const panel = body.current?.closest('.side-panel')?.getBoundingClientRect()
  const passage = draft?.range.getBoundingClientRect()
  const place = draft && passage ? placeCommentBox({
    passage,
    anchorX: draft.x,
    panel: panel ? { left: panel.left, right: panel.right } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    menu: menu ? { at: menu.at, ...PLAN_SELECTION_MENU } : null
  }) : null
  return (
    <>
      {draft && place && createPortal(
        <div className="plan-comment-box" style={{ left: place.left, top: place.top }} role="dialog" aria-label="评论这段计划">
          <input
            ref={input}
            className="plan-comment-input"
            autoFocus={!menu}
            value={comment}
            placeholder="评论这段，回车保存"
            aria-label="评论"
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(null)
              }
            }}
          />
          <button type="button" className="plan-comment-save" aria-label="保存评论" data-tooltip="保存评论（Enter）" data-tooltip-side="top-end" onClick={add}>
            <CommentAddIcon />
          </button>
        </div>,
        document.body
      )}
      {menu && (
        <ContextMenu at={menu.at} label="所选计划文字" onClose={closeMenu}>
          <MenuItem
            label="复制"
            onSelect={() => {
              closeMenu()
              void navigator.clipboard.writeText(menu.text).catch(() => {})
            }}
          />
        </ContextMenu>
      )}
    </>
  )
}
