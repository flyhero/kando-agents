import { useMemo, type ReactNode } from 'react'
import { common, createLowlight } from 'lowlight'
import { toolInputLanguage } from '../chat-tools'
import { shellTokens, type ShellTokenKind } from '../shell-highlight'

// The same languages rehype-highlight brings to the replies, so nothing more is bundled.
const lowlight = createLowlight(common)

type Root = ReturnType<typeof lowlight.highlight>
type Node = Root['children'][number]

// highlight.js marks tokens with spans of hljs-* classes alone, which the stylesheet colours.
function render(nodes: readonly Node[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null
    const className = node.properties.className
    return <span key={index} className={Array.isArray(className) ? className.join(' ') : undefined}>{render(node.children)}</span>
  })
}

// A command's pieces in the colours highlight.js gives the like in code.
const SHELL_CLASS: Record<ShellTokenKind, string> = {
  command: 'hljs-title',
  flag: 'hljs-attr',
  string: 'hljs-string',
  variable: 'hljs-variable',
  assignment: 'hljs-variable',
  operator: 'hljs-keyword',
  comment: 'hljs-comment'
}

function shell(input: string): ReactNode[] {
  return shellTokens(input).map((token, index) => (token.kind ? <span key={index} className={SHELL_CLASS[token.kind]}>{token.text}</span> : token.text))
}

// What a call was given, coloured as the language it is written in.
export function ChatToolInput({ name, input }: { name: string; input: string }) {
  const language = toolInputLanguage(name, input)
  const content = useMemo(() => (language === 'bash' ? shell(input) : language ? render(lowlight.highlight(language, input).children) : input), [language, input])
  return <pre className="chat-tool-io" data-language={language ?? undefined}>{content}</pre>
}
