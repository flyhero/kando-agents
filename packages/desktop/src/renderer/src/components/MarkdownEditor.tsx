import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { imageFilesOf } from '../attachment-images'
import { livePreview } from './markdown-live-preview'

const SAVE_DELAY_MS = 600

// CSS variables keep the editor in step with the app's light/dark palette.
const theme = EditorView.theme({
  '&': { flex: '1', minWidth: '0', minHeight: '0', color: 'var(--text)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', fontSize: '14px', lineHeight: '1.7' },
  '.cm-content': { padding: '14px 18px', caretColor: 'var(--accent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-placeholder': { color: 'var(--text-muted)' }
})

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.quote, color: 'var(--text-muted)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--text-muted)' }
])

type Props = {
  value: string
  onSave: (next: string) => void
  label: string
  hint: string
  // Renders `value` with the same live preview but accepts no input, for showing a proposal.
  readOnly?: boolean
}

// Uncontrolled: `value` only seeds the editor, so a remote update never clobbers typing.
export function MarkdownEditor({ value, onSave, label, hint, readOnly = false }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const save = useRef(onSave)

  useEffect(() => {
    save.current = onSave
  })

  useEffect(() => {
    const parent = host.current
    if (!parent) {
      return
    }
    let saved = value
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(timer)
      const next = view.state.doc.toString()
      if (next !== saved) {
        saved = next
        save.current(next)
      }
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          livePreview,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          placeholder(hint),
          theme,
          // Image files belong to the page around the editor (they become task images), so the
          // editor must neither paste nor drop them as text; returning true lets them pass through.
          EditorView.domEventHandlers({
            paste: (event) => imageFilesOf(event.clipboardData).length > 0,
            drop: (event) => imageFilesOf(event.dataTransfer).length > 0
          }),
          readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              clearTimeout(timer)
              timer = setTimeout(flush, SAVE_DELAY_MS)
            }
            if (update.focusChanged && !update.view.hasFocus) {
              flush()
            }
          })
        ]
      })
    })
    return () => {
      flush()
      view.destroy()
    }
  }, [])

  return <div className={readOnly ? 'md-editor md-editor-readonly' : 'md-editor'} ref={host} />
}
