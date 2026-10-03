import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { addQuote, useQuotes } from '../chat-quotes'
import { selectedTextIn, type SelectedText } from '../text-selection'
import { CommentAddIcon } from './icons'

// Where each comment's passage lies in the plan, by quote id, for its highlight. A range lasts
// while the plan's text stays rendered; one whose text is gone simply marks nothing.
const passages = new Map<string, Range>()

const DRAFT = 'kando-plan-draft'
// As .plan-comment-box is sized.
const BOX_WIDTH = 300
const BOX_HEIGHT = 48
const COMMENTED = 'kando-plan-comments'

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
      if (!(event.target instanceof Element && event.target.closest('.plan-comment-box'))) close()
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

  if (!draft) return null
  const add = () => {
    const id = addQuote(conversationId, planKey, draft.text, comment)
    if (id) passages.set(id, draft.range)
    document.getSelection()?.removeAllRanges()
    setDraft(null)
  }
  // Under the passage, centred on it, kept within the panel the plan is in; over it where the
  // window has no room below.
  const panel = body.current?.closest('.side-panel')?.getBoundingClientRect()
  const half = BOX_WIDTH / 2 + 8
  const left = Math.min(Math.max(draft.x, (panel?.left ?? 0) + half), (panel?.right ?? window.innerWidth) - half)
  const passage = draft.range.getBoundingClientRect()
  const above = passage.bottom + BOX_HEIGHT + 16 > window.innerHeight
  return createPortal(
    <div className="plan-comment-box" data-above={above || undefined} style={{ left, top: above ? passage.top : passage.bottom }} role="dialog" aria-label="评论这段计划">
      <input
        className="plan-comment-input"
        autoFocus
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
  )
}
