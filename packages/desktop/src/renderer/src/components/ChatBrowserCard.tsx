import { useContext, useState } from 'react'
import { browserToolKind, parseBrowserPage, toolImagePath, type ChatItem } from '@kando/protocol'
import { useImageUrl } from '../attachment-images'
import { useBrowserTabs, ALL_TABS } from '../browser-state'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { toolLabel } from '../chat-tools'
import { showBrowserTab, useCore } from '../core-store'
import { ChatPaths, ChevronRightIcon, ToolStatus, clipped } from './chat-tool-parts'
import { previewUrl } from '../file-links'
import { LocalImageViewer } from './ChatMarkdown'
import { ImageViewer } from './ImageViewer'
import { ChatToolIcon } from './ChatToolIcon'
import { ChatToolInput } from './ChatToolInput'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// A page as the agent saw it: the picture is the point, so it is shown whole, not as a thumbnail.
function BrowserShot({ image, onOpen }: { image: NonNullable<ToolItem['images']>[number]; onOpen: () => void }) {
  const url = useImageUrl(image.id)
  return (
    <button type="button" className="chat-browser-shot" style={{ aspectRatio: `${image.width} / ${image.height}` }} aria-label="查看截图" onClick={onOpen}>
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  )
}

// A picture the call looked at on disk, read from where it is (main's preview protocol): what it
// shows is the file as it is now, which a later shot under the same name replaces.
function FileShot({ path }: { path: string }) {
  const [viewing, setViewing] = useState(false)
  const [missing, setMissing] = useState(false)
  if (missing) return <p className="chat-tool-io chat-file-shot-missing muted">图片不在了：{path}</p>
  const src = previewUrl(path)
  return (
    <>
      <button type="button" className="chat-browser-shot chat-file-shot" aria-label={`查看图片 ${path}`} onClick={() => setViewing(true)}>
        <img src={src} alt="" draggable={false} onError={() => setMissing(true)} />
      </button>
      {viewing && <LocalImageViewer images={[{ path, src }]} index={0} onIndex={() => {}} onClose={() => setViewing(false)} />}
    </>
  )
}

// What a result says besides its pictures: the placeholder a picture left is dropped where it shows.
function outputBeside(output: string | null, shown: boolean): string | null {
  if (!shown || output === null) return output
  return output.split('\n').filter((line) => line.trim() !== '[图片]').join('\n').trim() || null
}

// The host a URL names, for a card's subtitle; the URL itself when it is not one.
function hostLine(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}` : url
  } catch {
    return url
  }
}

// A page the agent opened: its title and address, and the way to see it. The browser works in
// the background; 打开 brings the panel up on this tab. A navigation that did not come to a page
// (the user was asked, or refused) says so instead.
function ChatPageCard({ item }: { item: ToolItem }) {
  const page = item.output ? parseBrowserPage(item.output) : null
  const open = useCore((s) => s.browserPanelOpen)
  const shown = useBrowserTabs((s) => s[ALL_TABS]?.selectedId)
  const [viewing, setViewing] = useDisclosure(`card:${itemKey(item)}`)
  const label = typeof item.title === 'string' && item.title ? item.title : '页面'
  const current = page !== null && open && shown === page.id
  return (
    <div className="chat-tool chat-page" data-status={item.status}>
      <div className="chat-page-row">
        <ChatToolIcon name={item.name} status={item.status} />
        <div className="chat-page-text">
          <div className="chat-page-title">{page ? (page.title || hostLine(page.url)) : label}</div>
          <div className="chat-page-sub muted">
            {page ? <><span className="mono">{hostLine(page.url)}</span> · {current ? '显示在浏览器面板里' : '在浏览器里打开了'}</> : item.status === 'running' ? '正在打开…' : (item.output?.split('\n')[0] ?? '')}
          </div>
        </div>
        {page && !current && <button type="button" className="button chat-page-open" onClick={() => showBrowserTab(page.id)}>打开</button>}
        <ToolStatus status={item.status} since={item.at} />
      </div>
      {item.output && page && (
        <button type="button" className="chat-page-more link-button" aria-expanded={viewing} onClick={() => setViewing(!viewing)}>{viewing ? '收起快照' : '页面快照'}</button>
      )}
      {viewing && item.output && <pre className="chat-tool-io">{clipped(item.output)}</pre>}
    </div>
  )
}

// A browser call that brought back a picture: what it did on the page, and the page as it looked.
export function ChatBrowserCard({ item }: { item: ToolItem }) {
  if (browserToolKind(item.name) === 'navigate') return <ChatPageCard item={item} />
  return <ChatShotCard item={item} />
}

// A call that brought back pictures, or looked at one on disk. Pictures it brought back are the
// point, so they show whole under the call's line: a browser screenshot, an MCP one. A picture it
// read is mostly the agent checking its own work, often shown again as a preview, so it waits
// behind a click and is only loaded once opened.
export function ChatShotCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useDisclosure(`card:${itemKey(item)}`)
  const [viewing, setViewing] = useState<number | null>(null)
  const shorten = useContext(ChatPaths)
  const images = item.images ?? []
  const path = item.status === 'failed' || item.status === 'denied' ? null : toolImagePath(item)
  const output = outputBeside(item.output, images.length > 0 || path !== null)
  const details = Boolean(item.input || output || path)
  return (
    <div className="chat-tool chat-browser" data-status={item.status}>
      <button type="button" className="chat-tool-header" aria-expanded={details ? open : undefined} disabled={!details} onClick={() => setOpen(!open)}>
        <ChatToolIcon name={item.name} status={item.status} />
        <span className="chat-tool-name">{toolLabel(item.name)}{item.title ? ':' : ''}</span>
        <span className="chat-tool-title mono" title={item.title}>{shorten(item.title)}</span>
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={item.status} since={item.at} />
      </button>
      {images.map((image, index) => <BrowserShot key={image.id} image={image} onOpen={() => setViewing(index)} />)}
      {open && path && <FileShot path={path} />}
      {open && item.input && <ChatToolInput name={item.name} input={item.input} />}
      {open && output && <pre className="chat-tool-io">{clipped(output)}</pre>}
      {viewing !== null && images.length > 0 && (
        <ImageViewer
          images={images.map((image) => ({ ...image, name: '' }))}
          index={Math.min(viewing, images.length - 1)}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
