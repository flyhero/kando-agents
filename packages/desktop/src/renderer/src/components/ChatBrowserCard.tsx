import { useContext, useState } from 'react'
import { browserToolKind, parseBrowserPage, type ChatItem } from '@kando/protocol'
import { useImageUrl } from '../attachment-images'
import { useBrowserTabs, ALL_TABS } from '../browser-state'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { toolLabel } from '../chat-tools'
import { showBrowserTab, useCore } from '../core-store'
import { ChatPaths, ChevronRightIcon, ToolStatus, clipped } from './chat-tool-parts'
import { ImageViewer } from './ImageViewer'

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

function ChatShotCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useDisclosure(`card:${itemKey(item)}`)
  const [viewing, setViewing] = useState<number | null>(null)
  const shorten = useContext(ChatPaths)
  const images = item.images ?? []
  const details = Boolean(item.input || item.output)
  return (
    <div className="chat-tool chat-browser" data-status={item.status}>
      <button type="button" className="chat-tool-header" aria-expanded={details ? open : undefined} disabled={!details} onClick={() => setOpen(!open)}>
        <span className="chat-tool-name">{toolLabel(item.name)}{item.title ? ':' : ''}</span>
        <span className="chat-tool-title mono" title={item.title}>{shorten(item.title)}</span>
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={item.status} since={item.at} />
      </button>
      {images.map((image, index) => <BrowserShot key={image.id} image={image} onOpen={() => setViewing(index)} />)}
      {open && item.input && <pre className="chat-tool-io">{item.input}</pre>}
      {open && item.output && <pre className="chat-tool-io">{clipped(item.output)}</pre>}
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
