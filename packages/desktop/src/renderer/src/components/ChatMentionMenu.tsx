import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react'
import type { AgentKind, ProjectFileMatch } from '@kando/protocol'
import { useCore, useFileMentionsSupported } from '../core-store'
import { fileTarget, insertMention, matchProjects, mentionQuery, mentionText, type MentionTarget } from '../chat-mentions'
import { projectName } from './ProjectPicker'

// Long enough that a word typed at speed asks once.
const SEARCH_DELAY_MS = 80

type InputProps = Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSelect' | 'onInput' | 'aria-autocomplete' | 'aria-expanded' | 'aria-controls' | 'aria-activedescendant'> & {
  ref: RefObject<HTMLTextAreaElement | null>
}

// `opens`: what Tab puts after the @ to look inside a folder, its path under its project.
type MentionEntry = { key: string; group: 'files' | 'projects'; target: MentionTarget; name: string; detail: string; opens: string | null }

function fileEntry(match: ProjectFileMatch, cwd: string | null, manyRoots: boolean): MentionEntry {
  const folder = match.relative.includes('/') ? match.relative.slice(0, match.relative.lastIndexOf('/')) : ''
  const detail = manyRoots ? [projectName(match.root), folder].filter(Boolean).join('/') : folder
  const opens = match.kind === 'directory' ? `${match.relative}/` : null
  return { key: `file:${match.path}`, group: 'files', target: fileTarget(match, cwd), name: projectName(match.relative), detail, opens }
}

function MentionOption({ entry, id, active, onHover, onPick }: {
  entry: MentionEntry
  id: string
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <li
      ref={row}
      id={id}
      role="option"
      aria-selected={active}
      className="chat-command-option"
      // Keeps the focus in the input, which goes on taking the keys.
      onMouseDown={(event) => event.preventDefault()}
      // Only a pointer that moves picks a row, as in the command menu.
      onMouseMove={(event) => {
        if (!active && (event.movementX !== 0 || event.movementY !== 0)) onHover()
      }}
      onClick={onPick}
    >
      <span className="chat-command-option-name mono">{entry.name}{entry.target.kind === 'directory' ? '/' : ''}</span>
      <span className="chat-command-option-description">{entry.detail}</span>
    </li>
  )
}

// Files, folders and projects matching an @word the caret is in, above the input. Enter puts the
// one picked in as the agent reads a reference (see mentionText); Tab on a folder opens it to pick
// inside, and elsewhere picks too; Esc puts the list away until the text changes.
export function useChatMentionMenu({ text, setText, roots, cwd, agent }: {
  text: string
  setText: (text: string) => void
  // The folders the agent works in, its working folder first.
  roots: readonly string[]
  cwd: string | null
  agent: AgentKind | null
}): {
  menu: ReactNode
  inputProps: InputProps
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const listId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  // Where the caret goes once a pick's text is in the input.
  const placed = useRef<number | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [closedAt, setClosedAt] = useState<string | null>(null)
  const supported = useFileMentionsSupported() && agent !== null
  const rpc = useCore((s) => s.rpc)
  const range = supported ? mentionQuery(text, Math.min(caret, text.length)) : null
  const query = range?.query ?? null
  const rootsKey = roots.join('\0')
  // The latest answer stays until the next comes, so the list does not blink while typing.
  const [files, setFiles] = useState<ProjectFileMatch[]>([])
  const [projects, setProjects] = useState<string[] | null>(null)

  useLayoutEffect(() => {
    if (placed.current === null || !input.current) return
    input.current.setSelectionRange(placed.current, placed.current)
    setCaret(placed.current)
    placed.current = null
  }, [text])

  useEffect(() => {
    if (query === null || !rpc || !rootsKey) return
    let current = true
    const timer = setTimeout(() => {
      // Not through perform: a failed search only offers nothing.
      rpc.call('projects.searchFiles', { roots: rootsKey.split('\0'), query }).then(
        (found) => current && setFiles(found),
        () => current && setFiles([])
      )
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, rootsKey, rpc])

  const asking = query !== null
  useEffect(() => {
    if (!asking || !rpc || projects !== null) return
    let current = true
    rpc.call('projects.recent', {}).then((found) => current && setProjects(found), () => current && setProjects([]))
    return () => { current = false }
  }, [asking, rpc, projects])

  const shown = useMemo(() => {
    if (query === null) return []
    const fileRows = rootsKey ? files.map((match) => fileEntry(match, cwd, roots.length > 1)) : []
    const projectRows = matchProjects(projects ?? [], query).map((projectPath): MentionEntry => ({
      key: `project:${projectPath}`,
      group: 'projects',
      target: { kind: 'project', path: projectPath, relative: null },
      name: projectName(projectPath),
      detail: projectPath,
      opens: null
    }))
    return [...fileRows, ...projectRows]
  }, [query, files, projects, cwd, rootsKey, roots.length])
  const open = range !== null && text !== closedAt && shown.length > 0
  const active = Math.min(highlight, shown.length - 1)
  useEffect(() => setHighlight(0), [query])

  const place = (next: { text: string; caret: number }) => {
    placed.current = next.caret
    setText(next.text)
  }
  const pick = (entry: MentionEntry, tab: boolean) => {
    if (!range || !agent) return
    if (tab && entry.opens !== null) place(insertMention(text, range, `@${entry.opens}`, false))
    else place(insertMention(text, range, mentionText(entry.target, agent), true))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
    const entry = shown[active]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((active + step + shown.length) % shown.length)
    } else if (event.key === 'Escape') {
      setClosedAt(text)
    } else if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
      if (entry) pick(entry, event.key === 'Tab')
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  const optionId = (index: number) => `${listId}-${index}`
  const group = (which: MentionEntry['group'], label: string) => {
    const rows = shown.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.group === which)
    if (rows.length === 0) return null
    return (
      <li role="presentation" className="chat-command-group">
        <div className="menu-label">{label}</div>
        <ul role="group" aria-label={label} className="menu-list">
          {rows.map(({ entry, index }) => (
            <MentionOption
              key={entry.key}
              entry={entry}
              id={optionId(index)}
              active={index === active}
              onHover={() => setHighlight(index)}
              onPick={() => pick(entry, false)}
            />
          ))}
        </ul>
      </li>
    )
  }

  const menu = open ? (
    <div className="menu menu-up chat-command-menu">
      <ul id={listId} role="listbox" aria-label="引用文件或项目" className="menu-list">
        {group('files', '文件')}
        {group('projects', '项目')}
      </ul>
      <div className="chat-command-keys" aria-hidden="true">
        <kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 引用 <kbd>Tab</kbd> 打开文件夹 <kbd>Esc</kbd> 关闭
      </div>
    </div>
  ) : null

  const track = () => setCaret(input.current?.selectionStart ?? 0)
  const inputProps: InputProps = {
    ref: input,
    onSelect: track,
    onInput: track,
    // Only while open: the command menu describes the input otherwise.
    ...(open ? {
      'aria-autocomplete': 'list' as const,
      'aria-expanded': true,
      'aria-controls': listId,
      'aria-activedescendant': optionId(active)
    } : {})
  }
  return { menu, inputProps, onKeyDown }
}
