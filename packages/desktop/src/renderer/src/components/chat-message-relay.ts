import { createContext, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatItem } from '@kando/protocol'
import { relayMessage, type RelayMessage } from '../chat-message-relay'
import { entryKey, itemKey } from '../chat-state'

type Receipt = { accept(): void; cancel(): void }
type BeginRelay = (text: string, images: readonly string[], source: HTMLElement | null) => Receipt
const NO_RELAY: Receipt = { accept() {}, cancel() {} }
export const ChatMessageRelay = createContext<BeginRelay>(() => NO_RELAY)

type PendingRelay = RelayMessage & { accepted: boolean; origin: DOMRect }

function playRelay(view: HTMLElement, list: HTMLElement, message: HTMLElement, origin: DOMRect, key: string): () => void {
  const animations: Animation[] = []
  const layer = document.createElement('div')
  layer.className = 'chat-relay-layer'
  layer.setAttribute('aria-hidden', 'true')
  layer.inert = true
  const ghost = message.cloneNode(true)
  if (!(ghost instanceof HTMLElement)) return () => {}
  ghost.classList.add('chat-relay-message')
  const bounds = view.getBoundingClientRect()
  const destination = message.getBoundingClientRect()
  ghost.style.left = `${destination.left - bounds.left}px`
  ghost.style.top = `${destination.top - bounds.top}px`
  ghost.style.width = `${destination.width}px`
  layer.append(ghost)
  view.append(layer)

  const animate = (element: HTMLElement, frames: Keyframe[], duration: number, easing = 'cubic-bezier(.22,1,.36,1)') => {
    const animation = element.animate(frames, { duration, easing, fill: 'both' })
    animations.push(animation)
    return animation.finished
  }
  let disposed = false
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const cleanup = () => {
    if (disposed) return
    disposed = true
    for (const animation of animations) animation.cancel()
    layer.remove()
    view.removeEventListener('wheel', cleanup)
    view.removeEventListener('touchstart', cleanup)
    view.removeEventListener('pointerdown', cleanup)
    list.removeEventListener('keydown', cleanup)
    reduced.removeEventListener('change', cleanup)
    window.removeEventListener('resize', cleanup)
  }
  view.addEventListener('wheel', cleanup, { passive: true })
  view.addEventListener('touchstart', cleanup, { passive: true })
  view.addEventListener('pointerdown', cleanup, { passive: true })
  list.addEventListener('keydown', cleanup)
  reduced.addEventListener('change', cleanup)
  window.addEventListener('resize', cleanup)

  // The real bubble keeps its layout while its inert copy travels outside the scroll mask.
  const reveal = message.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 480, fill: 'both' })
  animations.push(reveal)
  void (async () => {
    await animate(ghost, [
      { transform: `translate(${origin.left - destination.left}px, ${origin.top - destination.top}px) scale(.96)`, opacity: .3 },
      { transform: 'none', opacity: 1 }
    ], 480)
    reveal.cancel()
    ghost.remove()
    const receiver = view.querySelector<HTMLElement>(`[data-relay-for="${CSS.escape(key)}"] .chat-turn-head-icon`)
      ?? view.querySelector<HTMLElement>('.chat-working .chat-spinner')
    if (!receiver) { cleanup(); return }
    const from = message.getBoundingClientRect()
    const to = receiver.getBoundingClientRect()
    const area = list.getBoundingClientRect()
    if (to.top < area.top || to.bottom > area.bottom) { cleanup(); return }
    const dot = document.createElement('span')
    dot.className = 'chat-relay-dot'
    dot.style.left = `${from.right - bounds.left - 8}px`
    dot.style.top = `${from.bottom - bounds.top - 4}px`
    layer.append(dot)
    await animate(dot, [
      { transform: 'translate(0, 0) scale(.6)', opacity: 0 },
      { opacity: 1, offset: .15 },
      { transform: `translate(${to.left + to.width / 2 - from.right + 8}px, ${to.top + to.height / 2 - from.bottom + 4}px) scale(.6)`, opacity: 0 }
    ], 320, 'cubic-bezier(.4,0,.2,1)')
    cleanup()
  })().catch(cleanup)
  return cleanup
}

export function useMessageRelay(view: RefObject<HTMLDivElement | null>, list: RefObject<HTMLDivElement | null>, items: readonly ChatItem[], conversationId: string): BeginRelay {
  const pending = useRef<PendingRelay | null>(null)
  const currentItems = useRef(items)
  currentItems.current = items
  const activeConversation = useRef<string | null>(conversationId)
  const playing = useRef<(() => void) | null>(null)
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [receipt, setReceipt] = useState(0)

  useLayoutEffect(() => {
    activeConversation.current = conversationId
    return () => {
      activeConversation.current = null
      pending.current = null
      playing.current?.()
      if (expiry.current) clearTimeout(expiry.current)
    }
  }, [conversationId])

  useLayoutEffect(() => {
    const sent = pending.current
    if (!sent?.accepted || !view.current || !list.current) return
    const matched = relayMessage(items, sent)
    if (!matched) return
    pending.current = null
    if (expiry.current) clearTimeout(expiry.current)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const key = entryKey({ kind: 'item', item: matched })
    const bubble = list.current.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"] .chat-user`)
    if (!bubble) return
    const target = bubble.getBoundingClientRect()
    const visible = list.current.getBoundingClientRect()
    if (target.top < visible.top || target.bottom > visible.bottom || target.width === 0) return
    playing.current?.()
    playing.current = playRelay(view.current, list.current, bubble, sent.origin, key)
  }, [items, receipt, view, list])

  return (text, images, source) => {
    if (!source || activeConversation.current !== conversationId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return NO_RELAY
    playing.current?.()
    if (expiry.current) clearTimeout(expiry.current)
    const sent: PendingRelay = { text, images, known: new Set(currentItems.current.map(itemKey)), origin: source.getBoundingClientRect(), accepted: false }
    pending.current = sent
    expiry.current = setTimeout(() => { if (pending.current === sent) pending.current = null }, 10_000)
    return {
      accept() {
        if (pending.current !== sent) return
        sent.accepted = true
        setReceipt((current) => current + 1)
      },
      cancel() {
        if (pending.current !== sent) return
        pending.current = null
        if (expiry.current) clearTimeout(expiry.current)
      }
    }
  }
}
