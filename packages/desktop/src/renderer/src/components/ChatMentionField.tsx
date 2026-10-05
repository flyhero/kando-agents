import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { caretOutside, markedRuns, mentionBeside, shiftMentions, type Mention, type MentionedText } from '../chat-mentions'

const EMPTY: MentionedText = { text: '', mentions: [] }
// How many of the texts the input held are kept with their mentions, for undo to find again.
const RECALLED = 100

// `caret`: where the caret is after the change, when the user made it by typing.
export type SetText = (next: string | ((current: string) => string), caret?: number | null) => void

// What the input holds: its text and the mentions in it, kept in step however the text changes
// (typing, a pick, a queued message put back). Undo and redo bring back a text the input held, so
// a text met before gets back the mentions it had.
export function useMentionedText(): { value: MentionedText; setText: SetText; setValue: (value: MentionedText) => void } {
  const [value, setState] = useState<MentionedText>(EMPTY)
  const latest = useRef(value)
  const held = useRef(new Map<string, readonly Mention[]>())
  const setValue = useCallback((next: MentionedText) => {
    latest.current = next
    held.current.delete(next.text)
    held.current.set(next.text, next.mentions)
    const oldest = held.current.keys().next().value
    if (held.current.size > RECALLED && oldest !== undefined) held.current.delete(oldest)
    setState(next)
  }, [])
  const setText = useCallback<SetText>((next, caret = null) => {
    const current = latest.current
    const text = typeof next === 'function' ? next(current.text) : next
    if (text === current.text) return
    setValue({ text, mentions: held.current.get(text) ?? shiftMentions(current.mentions, current.text, text, caret) })
  }, [setValue])
  return { value, setText, setValue }
}

// The input, and while it holds mentions, its text again beneath it with their names in colour.
// The textarea's own text goes transparent then, so this copy, laid out as the textarea lays out
// its own, is what shows; the textarea keeps the caret, the selection, input methods and undo. A
// mention is one piece: the caret steps over it, and Backspace or Delete beside it takes it whole.
export function MentionField({ value, input, children }: {
  value: MentionedText
  input: RefObject<HTMLTextAreaElement | null>
  children: ReactNode
}) {
  const marks = useRef<HTMLDivElement>(null)
  const mentions = useRef(value.mentions)
  // Where an input method's text began, and how long the text was without it.
  const [composing, setComposing] = useState<{ start: number; base: number } | null>(null)
  const marked = value.mentions.length > 0
  useLayoutEffect(() => {
    mentions.current = value.mentions
  }, [value.mentions])

  useEffect(() => {
    const element = input.current
    if (!element) return
    const settle = () => {
      if (document.activeElement !== element || element.selectionStart !== element.selectionEnd) return
      const caret = caretOutside(mentions.current, element.selectionStart)
      if (caret !== element.selectionStart) element.setSelectionRange(caret, caret)
    }
    // The arrows and deletions beside a mention, here rather than by where the caret lands: the
    // browser folds quick selection changes into one event, losing which way it went.
    const keys = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey) return
      const { selectionStart: start, selectionEnd: end } = element
      if ((event.key === 'Backspace' || event.key === 'Delete') && start === end) {
        const mention = mentionBeside(mentions.current, start, event.key === 'Delete')
        // Selected, the mention goes by the key's own deletion, which undo can bring back.
        if (mention) element.setSelectionRange(mention.start, mention.end)
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && (start === end || event.shiftKey)) {
        const forward = event.key === 'ArrowRight'
        const backward = element.selectionDirection === 'backward'
        const focus = start === end || backward ? start : end
        const anchor = start === end || !backward ? start : end
        const mention = mentionBeside(mentions.current, focus, forward)
        if (!mention) return
        event.preventDefault()
        const next = forward ? mention.end : mention.start
        if (event.shiftKey) element.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? 'backward' : 'forward')
        else element.setSelectionRange(next, next)
      }
    }
    const begin = () => setComposing({ start: element.selectionStart, base: element.value.length - (element.selectionEnd - element.selectionStart) })
    const end = () => setComposing(null)
    document.addEventListener('selectionchange', settle)
    element.addEventListener('keydown', keys)
    element.addEventListener('compositionstart', begin)
    element.addEventListener('compositionend', end)
    return () => {
      document.removeEventListener('selectionchange', settle)
      element.removeEventListener('keydown', keys)
      element.removeEventListener('compositionstart', begin)
      element.removeEventListener('compositionend', end)
    }
  }, [input])

  // The copy wraps where the textarea does only at its width, which a scrollbar narrows, and
  // scrolls with it.
  const align = useCallback(() => {
    const element = input.current
    const layer = marks.current
    if (!element || !layer) return
    layer.style.right = `${element.offsetWidth - element.clientWidth}px`
    layer.scrollTop = element.scrollTop
  }, [input])
  useLayoutEffect(align, [align, value.text, marked])
  useEffect(() => {
    const element = input.current
    if (!element || !marked) return
    const observer = new ResizeObserver(align)
    observer.observe(element)
    element.addEventListener('scroll', align)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', align)
    }
  }, [input, marked, align])

  const composed = composing && { start: composing.start, end: composing.start + value.text.length - composing.base }
  return (
    <div className="chat-input-field" data-marked={marked || undefined}>
      {marked && (
        <div ref={marks} className="chat-input-marks" aria-hidden="true">
          {markedRuns(value.text, value.mentions, composed).map((run, index) => (
            <span key={index} className={run.mention ? 'chat-mention' : undefined} data-composing={run.composing || undefined}>{run.text}</span>
          ))}
          {/* The empty last line the textarea shows after a line break, which a block would not. */}
          {value.text.endsWith('\n') && '​'}
        </div>
      )}
      {children}
    </div>
  )
}
