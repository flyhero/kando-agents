import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'

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
