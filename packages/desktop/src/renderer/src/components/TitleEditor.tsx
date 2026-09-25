import { useRef, useState } from 'react'

// Edits a title in place: Electron doesn't implement window.prompt.
// Enter or blur saves, Escape cancels; an empty or unchanged title saves nothing.
export function TitleEditor({ title, label, onSave, onDone }: {
  title: string
  label: string
  onSave: (title: string) => void
  onDone: () => void
}) {
  const [draft, setDraft] = useState(title)
  // Enter unmounts the input, which may also fire blur; save only once.
  const finished = useRef(false)
  const finish = (save: boolean) => {
    if (finished.current) return
    finished.current = true
    const next = draft.trim()
    if (save && next !== '' && next !== title) onSave(next)
    onDone()
  }
  return (
    <input
      className="input title-editor"
      value={draft}
      maxLength={200}
      aria-label={label}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
    />
  )
}
