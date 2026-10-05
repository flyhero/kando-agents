import { useContext, useState } from 'react'
import { isPreviewImage, type ChatItem } from '@kando/protocol'
import { openFileInBrowser } from '../browser-state'
import { useBrowserSupported } from '../core-store'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { previewUrl } from '../file-links'
import { LocalImageViewer } from './ChatMarkdown'
import { ChatPaths } from './ChatToolCard'
import { RefreshIcon } from './icons'
import { ChatToolIcon } from './ChatToolIcon'

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

// A picture the agent asked to show: fitted to the card, opened full size on a click.
function PreviewImage({ path, src, label }: { path: string; src: string; label: string }) {
  const [viewing, setViewing] = useState(false)
  const [missing, setMissing] = useState(false)
  if (missing) return <p className="chat-preview-note muted">图片不在了：{path}</p>
  return (
    <>
      <button type="button" className="chat-preview-image" aria-label={`查看图片 ${label}`} onClick={() => setViewing(true)}>
        <img src={src} alt="" draggable={false} onError={() => setMissing(true)} />
      </button>
      {viewing && <LocalImageViewer images={[{ path, src }]} index={0} onIndex={() => {}} onClose={() => setViewing(false)} />}
    </>
  )
}

// A file the agent asked to show, rendered where it asked. A page or an SVG is a frame that is a
// page of its own, with no way to the app around it or to the network (main's kando-preview
// protocol sets the policy), following the app's light or dark scheme; a picture is an image. It
// reads the file as it stands now, so a later edit shows on refresh.
export function ChatPreviewCard({ conversationId, item }: { conversationId: string; item: ToolItem }) {
  const { path, title } = previewArgs(item)
  const browsable = useBrowserSupported() && !isPreviewImage(path)
  const shorten = useContext(ChatPaths)
  const [generation, setGeneration] = useState(0)
  const refused = item.status === 'failed' || item.status === 'denied'
  const src = `kando-preview://file${path}?v=${generation}`
  return (
    <div className="chat-preview" data-status={item.status}>
      <div className="chat-preview-head">
        <ChatToolIcon name={item.name} status={item.status} />
        <span className="chat-preview-title">{title ?? shorten(path)}</span>
        {title && <span className="chat-preview-path" title={path}>{shorten(path)}</span>}
        <span className="chat-preview-actions">
          <button type="button" className="tool-button" aria-label="重新加载" data-tooltip="重新加载" data-tooltip-side="top-end" onClick={() => setGeneration((n) => n + 1)}><RefreshIcon /></button>
          {browsable && !refused && (
            <button type="button" className="link-button" data-tooltip="在内置浏览器里打开，全尺寸，Agent 也能看到这个标签页" data-tooltip-side="top-end" onClick={() => void openFileInBrowser(path, conversationId)}>在浏览器中打开</button>
          )}
          {canRevealFile() && (
            <button type="button" className="link-button" onClick={() => void revealFile([path])}>显示文件</button>
          )}
        </span>
      </div>
      {refused
        ? <p className="chat-preview-note muted">{item.output ?? '没能展示这个文件。'}</p>
        : isPreviewImage(path)
          ? <PreviewImage key={generation} path={path} src={`${previewUrl(path)}?v=${generation}`} label={title ?? path} />
          : <iframe key={generation} className="chat-preview-frame" title={title ?? path} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
    </div>
  )
}
