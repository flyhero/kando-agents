import { createContext, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatItem } from '@kando/protocol'
import { relayMessage, type RelayMessage } from '../chat-message-relay'
import { entryKey, itemKey } from '../chat-state'

type Receipt = { accept(): void; cancel(): void }
type BeginRelay = (text: string, images: readonly string[], source: HTMLElement | null) => Receipt
const NO_RELAY: Receipt = { accept() {}, cancel() {} }
export const ChatMessageRelay = createContext<BeginRelay>(() => NO_RELAY)

type PendingRelay = RelayMessage & { accepted: boolean; origin: DOMRect }

// The copy's flight from the composer to its place in the list, the crossfade to the real bubble
// at the end of it, and the dot's run on to the agent's icon. The way is only the height of the
// composer and the dock, so each leg takes long enough to be followed.
const FLIGHT_MS = 760
const HANDOVER_MS = 150
const DOT_MS = 450
// How far above the straight line the copy's flight bows.
const ARC_PX = 24

// How long the dot waits for somewhere to go: the agent's turn opens a beat after the message
// lands, and the dot is the handover to it.
const RECEIVER_WAIT_MS = 1200

// Where the dot runs to: the icon of the turn that answers the message, else the spinner of the
// working line, polled for a moment while the turn opens.
async function receiverFor(view: HTMLElement, key: string, disposed: () => boolean): Promise<HTMLElement | null> {
  const find = () => view.querySelector<HTMLElement>(`[data-relay-for="${CSS.escape(key)}"] .chat-turn-head-icon`)
    ?? view.querySelector<HTMLElement>('.chat-working .chat-spinner')
  const until = performance.now() + RECEIVER_WAIT_MS
  let found = find()
  while (!found && !disposed() && performance.now() < until) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    found = find()
  }
  return disposed() ? null : found
}

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

  // Slow out of the composer and slow into place: the way is short, so the whole of it must read.
  const animate = (element: HTMLElement, frames: Keyframe[], duration: number, easing = 'cubic-bezier(.45,0,.2,1)') => {
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
    reduced.removeEventListener('change', cleanup)
    window.removeEventListener('resize', cleanup)
  }
  // Only what moves the targets stops it: scrolling the list, or the window changing size. A
  // touch on the pad or a key after Enter used to end it before it was seen.
  view.addEventListener('wheel', cleanup, { passive: true })
  reduced.addEventListener('change', cleanup)
  window.addEventListener('resize', cleanup)

  // The real bubble keeps its layout while its inert copy travels outside the scroll mask, then
  // fades in under the copy as it fades out, so the handover is a crossfade and not a cut.
  const reveal = message.animate([{ opacity: 0 }, { opacity: 0 }], { duration: FLIGHT_MS, fill: 'both' })
  animations.push(reveal)
  void (async () => {
    const dx = origin.left - destination.left
    const dy = origin.top - destination.top
    // Bowed a little past the straight line, so the copy swings up into place rather than sliding.
    await animate(ghost, [
      { transform: `translate(${dx}px, ${dy}px) scale(.96)`, opacity: .7 },
      { transform: `translate(${dx * .45}px, ${dy * .5 - ARC_PX}px) scale(.98)`, opacity: 1, offset: .55 },
      { transform: 'none', opacity: 1 }
    ], FLIGHT_MS)
    reveal.cancel()
    await Promise.all([
      animate(message, [{ opacity: 0 }, { opacity: 1 }], HANDOVER_MS, 'ease-out'),
      animate(ghost, [{ opacity: 1 }, { opacity: 0 }], HANDOVER_MS, 'ease-out')
    ])
    ghost.remove()
    const receiver = await receiverFor(view, key, () => disposed)
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
      { opacity: 1, offset: .8 },
      { transform: `translate(${to.left + to.width / 2 - from.right + 8}px, ${to.top + to.height / 2 - from.bottom + 4}px) scale(.6)`, opacity: 0 }
    ], DOT_MS, 'cubic-bezier(.4,0,.2,1)')
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
