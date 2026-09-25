import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'

// Obsidian-style live preview: Markdown renders in place and its markup is hidden,
// except wherever the cursor is, so clicking into formatted text reveals the source.
// The document itself is never rewritten; everything here is a decoration.

const OPEN_LINK_HINT = `${PRIMARY_KEY_LABEL}点击打开`
const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark'])

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  override toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-lp-bullet'
    bullet.textContent = '•'
    return bullet
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked
  }
  override toDOM(): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-task'
    box.checked = this.checked
    return box
  }
  // Let the click reach the editor's mousedown handler, which toggles the source.
  override ignoreEvent(): boolean {
    return false
  }
}

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true
  }
  override toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-lp-hr'
    return rule
  }
}

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const rule = Decoration.replace({ widget: new RuleWidget() })
const checkedTask = Decoration.replace({ widget: new TaskWidget(true) })
const uncheckedTask = Decoration.replace({ widget: new TaskWidget(false) })

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const { doc } = state
  const focused = view.hasFocus
  const out: Range<Decoration>[] = []

  // Raw Markdown shows wherever a cursor or selection touches, and only while editing.
  const touches = (from: number, to: number) =>
    focused && state.selection.ranges.some((range) => range.from <= to && range.to >= from)
  const onActiveLine = (from: number, to = from) => touches(doc.lineAt(from).from, doc.lineAt(to).to)
  const text = (node: SyntaxNode) => doc.sliceString(node.from, node.to)
  // Replacements from a view plugin must stay within one line.
  const hide = (from: number, to: number) => {
    if (to > from && doc.lineAt(from).to >= to) {
      out.push(hidden.range(from, to))
    }
  }
  const eachLine = (node: SyntaxNode, classes: (index: number, count: number) => Array<string | false>) => {
    const first = doc.lineAt(node.from).number
    const last = doc.lineAt(node.to).number
    for (let n = first; n <= last; n++) {
      const className = classes(n - first, last - first + 1).filter(Boolean).join(' ')
      out.push(Decoration.line({ class: className }).range(doc.line(n).from))
    }
  }
  const codeLines = (index: number, count: number) => [
    'cm-lp-codeblock',
    index === 0 && 'cm-lp-codeblock-first',
    index === count - 1 && 'cm-lp-codeblock-last'
  ]
  const linkMark = (from: number, to: number, url: string) =>
    out.push(Decoration.mark({ class: 'cm-lp-link', attributes: { title: `${url}（${OPEN_LINK_HINT}）` } }).range(from, to))

  syntaxTree(state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter: (ref) => {
      const node = ref.node
      const heading = /^ATXHeading(\d)$/.exec(node.name)
      if (heading) {
        out.push(Decoration.line({ class: `cm-lp-heading cm-lp-h${heading[1]}` }).range(doc.lineAt(node.from).from))
        if (!onActiveLine(node.from)) {
          const marks = node.getChildren('HeaderMark')
          marks.forEach((mark, index) => {
            if (index === 0) {
              hide(mark.from, doc.sliceString(mark.to, mark.to + 1) === ' ' ? mark.to + 1 : mark.to)
            } else {
              // Optional closing hashes: hide them with the spaces before them.
              let start = mark.from
              while (start > node.from && doc.sliceString(start - 1, start) === ' ') {
                start--
              }
              hide(start, mark.to)
            }
          })
        }
        return
      }

      switch (node.name) {
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'InlineCode': {
          if (node.name === 'InlineCode') {
            out.push(Decoration.mark({ class: 'cm-lp-inline-code' }).range(node.from, node.to))
          }
          if (!touches(node.from, node.to)) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              if (INLINE_MARKS.has(child.name)) {
                hide(child.from, child.to)
              }
            }
          }
          return
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          const open = marks[0]
          const close = marks[1]
          // Reference-style links have no inline URL; leave them as written.
          if (!url || !open || !close) {
            return
          }
          linkMark(open.to, close.from, text(url))
          if (!touches(node.from, node.to)) {
            hide(open.from, open.to)
            hide(close.from, node.to)
          }
          return
        }
        case 'URL': {
          if (node.parent?.name !== 'Link' && node.parent?.name !== 'Image') {
            linkMark(node.from, node.to, text(node))
          }
          return
        }
        case 'Image':
          return false
        case 'ListMark': {
          const item = node.parent
          const task = item?.getChild('Task')
          const marker = task?.getChild('TaskMarker')
          if (task && marker) {
            const checked = /x/i.test(text(marker))
            if (checked && task.to > marker.to) {
              out.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(marker.to, task.to))
            }
            if (!onActiveLine(node.from)) {
              out.push((checked ? checkedTask : uncheckedTask).range(node.from, marker.to))
            }
          } else if (item?.parent?.name === 'BulletList' && !onActiveLine(node.from)) {
            out.push(bullet.range(node.from, node.to))
          }
          return
        }
        case 'Blockquote':
          eachLine(node, () => ['cm-lp-quote'])
          return
        case 'QuoteMark':
          if (!onActiveLine(node.from)) {
            hide(node.from, doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to)
          }
          return
        case 'FencedCode': {
          const active = onActiveLine(node.from, node.to)
          const closed = node.getChildren('CodeMark').length > 1
          eachLine(node, (index, count) => {
            const isFence = index === 0 || (closed && index === count - 1)
            return [...codeLines(index, count), isFence && !active && 'cm-lp-fence']
          })
          if (!active) {
            const first = doc.lineAt(node.from)
            hide(first.from, first.to)
            if (closed) {
              const last = doc.lineAt(node.to)
              hide(last.from, last.to)
            }
          }
          return false
        }
        case 'CodeBlock':
          eachLine(node, codeLines)
          return false
        case 'HorizontalRule':
          if (!onActiveLine(node.from)) {
            out.push(rule.range(node.from, node.to))
          }
          return
        // Hiding pipes would break column alignment, so tables stay as source in a monospace font.
        case 'Table':
          eachLine(node, () => ['cm-lp-table'])
          return false
      }
    }
  })

  return Decoration.set(out, true)
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

function ancestor(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (current.name === name) {
      return current
    }
  }
  return null
}

function toggleTask(view: EditorView, pos: number): boolean {
  // Read-only only blocks typing; a programmatic change would still go through.
  if (view.state.readOnly) {
    return true
  }
  const item = ancestor(syntaxTree(view.state).resolveInner(pos, 1), 'ListItem')
  const marker = item?.getChild('Task')?.getChild('TaskMarker')
  if (!marker) {
    return false
  }
  const checked = /x/i.test(view.state.doc.sliceString(marker.from, marker.to))
  view.dispatch({ changes: { from: marker.from + 1, to: marker.from + 2, insert: checked ? ' ' : 'x' } })
  return true
}

function linkAt(view: EditorView, event: MouseEvent): string | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null) {
    return null
  }
  const inner = syntaxTree(view.state).resolveInner(pos, 1)
  const url = ancestor(inner, 'URL') ?? ancestor(inner, 'Link')?.getChild('URL')
  return url ? view.state.doc.sliceString(url.from, url.to) : null
}

const clicks = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.classList.contains('cm-lp-task')) {
      event.preventDefault()
      return toggleTask(view, view.posAtDOM(target))
    }
    if (hasPrimaryModifier(event)) {
      const url = linkAt(view, event)
      if (url) {
        event.preventDefault()
        // Main's window-open handler decides what may leave the app (https only).
        window.open(url, '_blank')
        return true
      }
    }
    return false
  }
})

export const livePreview = [decorations, clicks]
