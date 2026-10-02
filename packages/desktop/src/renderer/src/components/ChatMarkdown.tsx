import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { perform, showError, useFindFileSupported } from '../core-store'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { fileCandidates, fileReference, isImagePath, linkTarget, previewUrl, type FileReference, type LinkTarget } from '../file-links'
import { CopyButton } from './CopyButton'
import { ImageViewer, type ViewerImage } from './ImageViewer'

// The folders a conversation works in, the primary first: where a file a reply names is looked for.
export const ChatRoots = createContext<readonly string[]>([])

const FILE_MANAGER = window.kando?.platform === 'darwin' ? '访达' : window.kando?.platform === 'win32' ? '资源管理器' : '文件管理器'

// A file a reply names, shown in the file manager on a click; never opened, as a reply can name
// anything. Agents often write a bare name, so when it is nowhere it was tried directly, core
// looks it up in the projects; the shallowest of several files by that name is shown.
// `code` is inline code naming the file; without it, a link's own words.
function FileLink({ reference, code = true, children }: { reference: FileReference; code?: boolean; children: ReactNode }) {
  const roots = useContext(ChatRoots)
  const searchable = useFindFileSupported()
  const candidates = fileCandidates(reference.path, roots)
  if (candidates.length === 0) return code ? <code>{children}</code> : <>{children}</>
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
      className={code ? 'chat-file-link' : 'chat-link'}
      title={`在${FILE_MANAGER}中显示 ${reference.path}`}
      onClick={() => void reveal()}
    >
      {code ? <code>{children}</code> : children}
    </button>
  )
}

type LocalImage = { path: string; src: string }

// An image file a reply names, read through main's preview protocol: one with an absolute path, or
// a relative one under the conversation's primary folder, where the agent works.
function localImage(target: LinkTarget | null, roots: readonly string[]): LocalImage | null {
  if (target?.kind !== 'file' || !isImagePath(target.path) || !canRevealFile()) return null
  const [path] = fileCandidates(target.path, roots)
  return path?.startsWith('/') ? { path, src: previewUrl(path) } : null
}

function viewerImage(image: LocalImage): ViewerImage {
  return { id: image.src, name: image.path, width: 0, height: 0, src: image.src }
}

// The viewer is a modal of its own; portaled, it never ends up inside the paragraph that opened it.
function LocalImageViewer({ images, index, onIndex, onClose }: {
  images: readonly LocalImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  return createPortal(<ImageViewer images={images.map(viewerImage)} index={index} onIndex={onIndex} onClose={onClose} />, document.body)
}

function LocalImageStrip({ images }: { images: readonly LocalImage[] }) {
  const [viewing, setViewing] = useState<number | null>(null)
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  return (
    <span className="chat-images chat-reply-images">
      {images.map((image, index) =>
        missing.has(image.src) ? (
          <span key={image.src} className="muted chat-image-missing" title={image.path}>
            图片不在了：{image.path.split('/').at(-1)}
          </span>
        ) : (
          <span key={image.src} className="chat-image">
            <button type="button" className="chat-image-button" title={image.path} aria-label={`查看图片 ${image.path}`} onClick={() => setViewing(index)}>
              <img src={image.src} alt="" draggable={false} onError={() => setMissing((current) => new Set(current).add(image.src))} />
            </button>
          </span>
        )
      )}
      {viewing !== null && <LocalImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />}
    </span>
  )
}

function ImageLink({ image, children }: { image: LocalImage; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="chat-link" title={`查看图片 ${image.path}`} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <LocalImageViewer images={[image]} index={0} onIndex={() => {}} onClose={() => setOpen(false)} />}
    </>
  )
}

// A web page opens in the browser; a file shows in the file manager, or, an image, in the viewer.
function ChatLink({ href, title, children }: { href?: string; title?: string; children: ReactNode }) {
  const roots = useContext(ChatRoots)
  const target = href ? linkTarget(href) : null
  const image = localImage(target, roots)
  if (image) return <ImageLink image={image}>{children}</ImageLink>
  if (target?.kind === 'file' && canRevealFile()) return <FileLink reference={target} code={false}>{children}</FileLink>
  return <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a>
}

// An image a reply embeds. One on this machine is shown; one on the web is not fetched, which would
// tell its server the reply was read, but offered as a link.
function ReplyImage({ src, alt }: { src?: string; alt?: string }) {
  const roots = useContext(ChatRoots)
  const target = src ? linkTarget(src) : null
  const image = localImage(target, roots)
  if (image) return <LocalImageStrip images={[image]} />
  if (target?.kind === 'web') return <a href={target.href} title={target.href} target="_blank" rel="noreferrer">图片：{alt || target.href}</a>
  return <>{alt}</>
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

// Blocks show their own linked images; a paragraph or list item looks only at its inline content.
const BLOCKS = new Set(['p', 'ul', 'ol', 'pre', 'blockquote', 'table', 'div'])

// The images a paragraph's links lead to, shown under it, so the link keeps its place in the sentence.
function LinkedImages({ node }: { node: HastElement | undefined }) {
  const roots = useContext(ChatRoots)
  const found = new Map<string, LocalImage>()
  const walk = (element: HastElement) => {
    for (const child of element.children) {
      if (child.type !== 'element' || BLOCKS.has(child.tagName)) continue
      const href = child.properties.href
      const image = child.tagName === 'a' && typeof href === 'string' ? localImage(linkTarget(href), roots) : null
      if (image) found.set(image.src, image)
      walk(child)
    }
  }
  if (node) walk(node)
  return found.size > 0 ? <LocalImageStrip images={[...found.values()]} /> : null
}

// react-markdown drops what it cannot tell is safe, a.ts:12 and file:// among it; a file is shown
// by Kando rather than followed, so its link is kept.
function urlTransform(url: string): string {
  return linkTarget(url)?.kind === 'file' ? url : defaultUrlTransform(url)
}

function languageOf(code: HastElement | undefined): string | null {
  const classes = code?.properties.className
  const fence = Array.isArray(classes) ? classes.map(String).find((name) => name.startsWith('language-')) : undefined
  return fence ? fence.slice('language-'.length) : null
}

// Raw HTML in a reply stays text (react-markdown does not render it without rehype-raw). A web link
// opens a new window, which main hands to the browser for http(s) and refuses otherwise; a file's
// link and image are Kando's to show. A code block carries its language and a copy button above it.
const components: Components = {
  a: ({ node: _node, href, title, children }) => <ChatLink href={href} title={title}>{children}</ChatLink>,
  img: ({ node: _node, src, alt }) => <ReplyImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  p: ({ node, ...props }) => (
    <>
      <p {...props} />
      <LinkedImages node={node} />
    </>
  ),
  li: ({ node, children, ...props }) => (
    <li {...props}>
      {children}
      <LinkedImages node={node} />
    </li>
  ),
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
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={highlight ? rehypePlugins : []} components={components} urlTransform={urlTransform}>
        {text}
      </Markdown>
    </div>
  )
}
