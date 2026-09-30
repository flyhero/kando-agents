import { useContext, useState } from 'react'
import type { ChatItem } from '@kando/protocol'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { ChatPaths } from './ChatToolCard'
import { RefreshIcon } from './icons'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// What the agent asked to show: the file, and a title if it gave one.
function previewArgs(item: ToolItem): { path: string; title: string | null } {
  try {
    const parsed: unknown = item.input ? JSON.parse(item.input) : null
    if (parsed && typeof parsed === 'object') {
      const path = 'path' in parsed && typeof parsed.path === 'string' ? parsed.path : item.title
      const title = 'title' in parsed && typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
      return { path, title }
    }
  } catch {
    // The title is the path the agent gave, as describeClaudeTool took it.
  }
  return { path: item.title, title: null }
}

// A file the agent asked to show, rendered where it asked: in a frame that is a page of its own,
// with no way to the app around it or to the network (main's kando-preview protocol sets the
// policy), following the app's light or dark scheme. It reads the file as it stands now, so a
// later edit shows on refresh.
export function ChatPreviewCard({ item }: { item: ToolItem }) {
  const { path, title } = previewArgs(item)
  const shorten = useContext(ChatPaths)
  const [generation, setGeneration] = useState(0)
  const refused = item.status === 'failed' || item.status === 'denied'
  const src = `kando-preview://file${path}?v=${generation}`
  return (
    <div className="chat-preview" data-status={item.status}>
      <div className="chat-preview-head">
        <span className="chat-preview-title">{title ?? shorten(path)}</span>
        {title && <span className="chat-preview-path" title={path}>{shorten(path)}</span>}
        <span className="chat-preview-actions">
          <button type="button" className="tool-button" aria-label="重新加载" data-tooltip="重新加载" data-tooltip-side="top-end" onClick={() => setGeneration((n) => n + 1)}><RefreshIcon /></button>
          {canRevealFile() && (
            <button type="button" className="link-button" onClick={() => void revealFile([path])}>显示文件</button>
          )}
        </span>
      </div>
      {refused
        ? <p className="chat-preview-note muted">{item.output ?? '没能展示这个文件。'}</p>
        : <iframe key={generation} className="chat-preview-frame" title={title ?? path} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
    </div>
  )
}
