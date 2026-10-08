import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { defaultKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { saveFileScroll, updateFileTabs, useFileTabs, type FileTab } from '../file-tabs'
import { copyFileText } from '../file-actions'
import { ContextMenu, MenuItem, menuPoint, type MenuPoint } from './ContextMenu'

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: tags.comment, color: 'var(--code-comment)' },
  { tag: [tags.function(tags.variableName), tags.heading], color: 'var(--code-title)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: 'var(--code-variable)' }
])

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--chat-font-size, 14px)', lineHeight: '1.7' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { color: 'var(--text-3)', backgroundColor: 'var(--surface)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--fill-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-bg)' },
  '.cm-panels': { color: 'var(--text)', backgroundColor: 'var(--surface)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--fill-2)', outline: '1px solid var(--text-3)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-bg)', outline: '1px solid var(--accent)' }
})

export type FileSourceHandle = { search(): void }

export function FileSource({ conversationId, tab, text, wrap, ref }: {
  conversationId: string; tab: FileTab; text: string; wrap: boolean; ref?: Ref<FileSourceHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const wrapping = useRef(new Compartment())
  const [menu, setMenu] = useState<{ at: MenuPoint; selected: string; text: string } | null>(null)
  const close = useCallback(() => setMenu(null), [])
  const path = tab.file.path
  useImperativeHandle(ref, () => ({ search: () => { if (editor.current) openSearchPanel(editor.current) } }), [])

  useEffect(() => {
    if (!host.current) return
    let current = true
    const language = new Compartment()
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': path, 'aria-readonly': 'true', tabindex: '0' }),
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          keymap.of([...searchKeymap, ...defaultKeymap]), search({ top: true }),
          EditorState.phrases.of({ 'Find': '搜索', 'next': '下一个', 'previous': '上一个', 'all': '全部', 'match case': '区分大小写', 'regexp': '正则', 'by word': '全词', 'close': '关闭' }),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []), language.of([]), syntaxHighlighting(highlight), theme
        ]
      })
    })
    editor.current = view
    const saved = useFileTabs.getState()[conversationId]?.tabs.find((tab) => tab.file.path === path)
    const restore = requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = saved?.scrollTop ?? 0
      view.scrollDOM.scrollLeft = saved?.scrollLeft ?? 0
    })
    const scroll = () => saveFileScroll(conversationId, path, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft)
    view.scrollDOM.addEventListener('scroll', scroll)
    const description = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).at(-1) ?? path)
    if (description) void description.load().then((support) => {
      if (current) view.dispatch({ effects: language.reconfigure(support) })
    }).catch(() => {})
    return () => {
      current = false
      cancelAnimationFrame(restore)
      view.scrollDOM.removeEventListener('scroll', scroll)
      view.destroy()
      editor.current = null
    }
  }, [conversationId, path])

  useEffect(() => {
    const view = editor.current
    if (!view || view.state.doc.toString() === text) return
    const top = view.scrollDOM.scrollTop
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    view.scrollDOM.scrollTop = top
  }, [text])
  useEffect(() => { editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }) }, [wrap])
  useEffect(() => {
    const view = editor.current
    if (!view || tab.line === null) return
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, tab.line))).from
    const frame = requestAnimationFrame(() => {
      view.dispatch({ selection: { anchor: line }, effects: EditorView.scrollIntoView(line, { y: 'center' }) })
      view.focus()
      updateFileTabs(conversationId, (state) => ({ ...state, tabs: state.tabs.map((each) => each.file.path === path && each.reveal === tab.reveal ? { ...each, line: null } : each) }))
    })
    return () => cancelAnimationFrame(frame)
  }, [conversationId, path, tab.line, tab.reveal])

  return <div className="file-source" ref={host} onContextMenu={(event) => {
    event.preventDefault()
    const view = editor.current
    if (!view) return
    const selection = view.state.selection.main
    setMenu({ at: menuPoint(event), selected: view.state.sliceDoc(selection.from, selection.to), text: view.state.doc.toString() })
  }}>
    {menu && <ContextMenu at={menu.at} label="文件内容" onClose={close}>
      {menu.selected && <MenuItem label="复制选中内容" onSelect={() => { close(); void copyFileText(menu.selected) }} />}
      <MenuItem label="复制全部内容" onSelect={() => { close(); void copyFileText(menu.text) }} />
    </ContextMenu>}
  </div>
}
