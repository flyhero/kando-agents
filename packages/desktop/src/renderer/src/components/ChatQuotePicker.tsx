import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { addQuote } from '../chat-quotes'
import { QuoteIcon } from './icons'

type Picked = { x: number; y: number; below: boolean; text: string; source: string | null }

// The reply a node of the selection is in, if it is one of the agent's.
function replyOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest<HTMLElement>('.chat-assistant') ?? null
}

// Text selected within one of the agent's replies offers a button over it that quotes it into
// the input, where the user can say what about it. The selection stays the browser's own.
export function ChatQuotePicker({ conversationId, list }: { conversationId: string; list: RefObject<HTMLElement | null> }) {
  const [picked, setPicked] = useState<Picked | null>(null)

  useEffect(() => {
    const element = list.current
    if (!element) return
    const read = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return setPicked(null)
      const range = selection.getRangeAt(0)
      const reply = replyOf(range.startContainer)
      const text = selection.toString().trim()
      if (!reply || reply !== replyOf(range.endContainer) || !element.contains(reply) || !text) return setPicked(null)
      const box = range.getBoundingClientRect()
      // Over the selection, unless that would run above the list.
      const below = box.top - 40 < element.getBoundingClientRect().top
      setPicked({
        x: box.left + box.width / 2,
        y: below ? box.bottom : box.top,
        below,
        text,
        source: reply.closest<HTMLElement>('[data-entry-key]')?.dataset.entryKey ?? null
      })
    }
    // Once the pointer or the keys let go, so the button does not chase a drag.
    const settle = () => setTimeout(read, 0)
    const cleared = () => {
      if (document.getSelection()?.isCollapsed) setPicked(null)
    }
    const away = () => setPicked(null)
    document.addEventListener('mouseup', settle)
    element.addEventListener('keyup', settle)
    document.addEventListener('selectionchange', cleared)
    element.addEventListener('scroll', away)
    window.addEventListener('resize', away)
    return () => {
      document.removeEventListener('mouseup', settle)
      element.removeEventListener('keyup', settle)
      document.removeEventListener('selectionchange', cleared)
      element.removeEventListener('scroll', away)
      window.removeEventListener('resize', away)
    }
  }, [list])

  if (!picked) return null
  return createPortal(
    <button
      type="button"
      className="chat-quote-pick"
      data-below={picked.below || undefined}
      style={{ left: picked.x, top: picked.y }}
      // Pressing it must not drop the selection before the click reads it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        addQuote(conversationId, picked.source, picked.text)
        document.getSelection()?.removeAllRanges()
        setPicked(null)
        list.current?.closest('.chat-view')?.querySelector<HTMLTextAreaElement>('.chat-input')?.focus()
      }}
    >
      <QuoteIcon />
      引用
    </button>,
    document.body
  )
}
