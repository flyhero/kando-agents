import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Raw HTML in a reply stays text (react-markdown does not render it without rehype-raw), and a link
// opens a new window, which main hands to the browser for https and refuses otherwise.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
