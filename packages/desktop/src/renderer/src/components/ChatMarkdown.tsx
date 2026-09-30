import { createContext, useContext, type ReactNode } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { perform, showError, useFindFileSupported } from '../core-store'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { fileCandidates, fileReference, type FileReference } from '../file-links'
import { CopyButton } from './CopyButton'

// The folders a conversation works in, the primary first: where a file a reply names is looked for.
export const ChatRoots = createContext<readonly string[]>([])

const FILE_MANAGER = window.kando?.platform === 'darwin' ? '访达' : window.kando?.platform === 'win32' ? '资源管理器' : '文件管理器'

// A file a reply names, shown in the file manager on a click; never opened, as a reply can name
// anything. Agents often write a bare name, so when it is nowhere it was tried directly, core
// looks it up in the projects; the shallowest of several files by that name is shown.
function FileLink({ reference, children }: { reference: FileReference; children: ReactNode }) {
  const roots = useContext(ChatRoots)
  const searchable = useFindFileSupported()
  const candidates = fileCandidates(reference.path, roots)
  if (candidates.length === 0) return <code>{children}</code>
  const reveal = async () => {
    if (await revealFile(candidates)) return
    const found = searchable && roots.length > 0 && !reference.path.startsWith('/')
      ? await perform((rpc) => rpc.call('projects.findFile', { roots: [...roots], path: reference.path }))
      : null
    if (found && found.length > 0 && await revealFile(found)) return
    showError(`找不到文件：${reference.path}`)
  }
  return (
    <button
      type="button"
      className="chat-file-link"
      title={`在${FILE_MANAGER}中显示 ${reference.path}`}
      onClick={() => void reveal()}
    >
      <code>{children}</code>
    </button>
  )
}

type HastElement = NonNullable<ExtraProps['node']>
type HastChild = HastElement['children'][number]

// A newline in a reply is a line break, as it is in the agent's terminal, not a space.
const remarkPlugins = [remarkGfm, remarkBreaks]
// Code is coloured by its fence's language; one highlight.js does not know stays plain.
const rehypePlugins = [rehypeHighlight]

function textOf(node: HastElement | HastChild): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

function languageOf(code: HastElement | undefined): string | null {
  const classes = code?.properties.className
  const fence = Array.isArray(classes) ? classes.map(String).find((name) => name.startsWith('language-')) : undefined
  return fence ? fence.slice('language-'.length) : null
}

// Raw HTML in a reply stays text (react-markdown does not render it without rehype-raw), and a link
// opens a new window, which main hands to the browser for https and refuses otherwise. A code block
// carries its language and a copy button above it.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  // Inline code is a string with no newline and no language; a block's always ends in one.
  code: ({ node: _node, className, children, ...props }) => {
    const reference = !className && typeof children === 'string' && !children.includes('\n') && canRevealFile() ? fileReference(children) : null
    return reference ? <FileLink reference={reference}>{children}</FileLink> : <code className={className} {...props}>{children}</code>
  },
  pre: ({ node, ...props }) => {
    const code = node?.children.find((child): child is HastElement => child.type === 'element' && child.tagName === 'code')
    const language = languageOf(code)
    return (
      <div className="chat-code">
        <div className="chat-code-header">
          <span className="chat-code-language">{language ?? ''}</span>
          <CopyButton text={code ? textOf(code).replace(/\n$/, '') : ''} label="复制代码" />
        </div>
        <pre {...props} />
      </div>
    )
  }
}

// A reply still streaming is left uncoloured: it would be highlighted again at every delta.
export function ChatMarkdown({ text, highlight = true }: { text: string; highlight?: boolean }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={highlight ? rehypePlugins : []} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
