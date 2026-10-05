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
// The hand-on: a dashed line drawn from under the message, down to the agent's head and left along
// it, its dashes running the way the message goes; then held a beat, and faded.
const DRAW_MS = 620
const HOLD_MS = 260
const FADE_MS = 240
// Room kept between the line and the bubble above it, and the head's last word beside it.
const LINE_GAP_PX = 10
const SVG_NS = 'http://www.w3.org/2000/svg'
// How far above the straight line the copy's flight bows.
const ARC_PX = 24

// How long the dot waits for somewhere to go: the agent's turn opens a beat after the message
// lands, and the dot is the handover to it.
const RECEIVER_WAIT_MS = 1200

// Where the line runs to: the head of the turn that answers the message, else the working line,
// polled for a moment while the turn opens.
async function receiverFor(view: HTMLElement, key: string, disposed: () => boolean): Promise<HTMLElement | null> {
  const find = () => view.querySelector<HTMLElement>(`[data-relay-for="${CSS.escape(key)}"]`)
    ?? view.querySelector<HTMLElement>('.chat-working')
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
    // The head's entry comes in with a motion of its own (chat-entry-in); measured mid-way, the
    // line would end short of the head's last word.
    await Promise.race([
      Promise.all((receiver.closest<HTMLElement>('.chat-entry') ?? receiver).getAnimations({ subtree: true }).filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 600))
    ])
    if (disposed) return
    const from = message.getBoundingClientRect()
    const to = receiver.getBoundingClientRect()
    const area = list.getBoundingClientRect()
    if (to.top < area.top || to.bottom > area.bottom) { cleanup(); return }
    // Down from under the bubble, a little right of its middle, to the head's height; then left to
    // just past the head's last word (its time).
    const startX = from.left + from.width * .55 - bounds.left
    const startY = from.bottom + LINE_GAP_PX - bounds.top
    const words = [...receiver.children].map((child) => child.getBoundingClientRect().right)
    const endX = Math.max(to.left, ...words) + LINE_GAP_PX - bounds.left
    const endY = to.top + to.height / 2 - bounds.top
    if (endY <= startY) { cleanup(); return }
    const d = `M ${startX} ${startY} V ${endY} H ${endX}`
    const length = (endY - startY) + Math.abs(startX - endX)

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.classList.add('chat-relay-line')
    const mask = document.createElementNS(SVG_NS, 'mask')
    const maskId = `chat-relay-mask-${Math.random().toString(36).slice(2)}`
    mask.id = maskId
    mask.setAttribute('maskUnits', 'userSpaceOnUse')
    const reach = document.createElementNS(SVG_NS, 'path')
    reach.setAttribute('d', d)
    reach.classList.add('chat-relay-reach')
    reach.style.strokeDasharray = `${length} ${length}`
    mask.append(reach)
    const line = document.createElementNS(SVG_NS, 'path')
    line.setAttribute('d', d)
    line.classList.add('chat-relay-dashes')
    line.setAttribute('mask', `url(#${maskId})`)
    svg.append(mask, line)
    layer.append(svg)
    const dot = document.createElement('span')
    dot.className = 'chat-relay-dot'
    dot.style.offsetPath = `path('${d}')`
    layer.append(dot)

    const track = (animation: Animation) => { animations.push(animation); return animation }
    // The dashes run toward the head the whole time; the line is drawn on behind the dot.
    track(line.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -18 }], { duration: 600, iterations: Infinity }))
    await Promise.all([
      track(reach.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'both' })).finished,
      animate(dot, [
        { offsetDistance: '0%', opacity: 0 },
        { opacity: 1, offset: .1 },
        { offsetDistance: '100%', opacity: 1 }
      ], DRAW_MS)
    ])
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    if (disposed) return
    await Promise.all([
      track(svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'both' })).finished,
      animate(dot, [{ offsetDistance: '100%', opacity: 1, transform: 'scale(1)' }, { offsetDistance: '100%', opacity: 0, transform: 'scale(1.8)' }], FADE_MS, 'ease-out')
    ])
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
