import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, type ChatImage } from '@kando/protocol'
import { copyImageToClipboard, imageFilesOf, uploadImageFiles, useImageUrl } from '../attachment-images'
import { useCore } from '../core-store'
import { fitChatImage } from '../image-fit'
import { CheckIcon, CloseIcon, CopyIcon, ImageIcon, PlusIcon, SearchIcon } from './icons'
import { ImageViewer } from './ImageViewer'
import { Popover } from './Popover'

// Images the composer holds for its next message, uploaded as they come from a paste, a drop or
// the picker, so that sending only names them.
export function useComposerImages() {
  const [images, setImages] = useState<ChatImage[]>([])
  const [uploading, setUploading] = useState(0)
  const add = (files: File[]) => {
    if (images.length + uploading >= MAX_CHAT_IMAGES) {
      useCore.setState({ error: `一条消息最多带 ${MAX_CHAT_IMAGES} 张图片` })
      return
    }
    setUploading((count) => count + files.length)
    void (async () => {
      const uploaded = await uploadImageFiles(await Promise.all(files.map(fitChatImage)))
      setUploading((count) => count - files.length)
      setImages((current) => {
        const known = new Set(current.map((image) => image.id))
        const fresh = uploaded.filter((image) => !known.has(image.id)).map(({ id, width, height }) => ({ id, width, height }))
        const next = [...current, ...fresh].slice(0, MAX_CHAT_IMAGES)
        if (next.length < current.length + fresh.length) useCore.setState({ error: `一条消息最多带 ${MAX_CHAT_IMAGES} 张图片` })
        return next
      })
    })()
  }
  const remove = (id: string) => setImages((current) => current.filter((image) => image.id !== id))
  // Only a clipboard or drag that carries image files is taken; text goes where it was going.
  const handlers = {
    onPaste: (event: ClipboardEvent) => {
      const files = imageFilesOf(event.clipboardData)
      if (files.length > 0) {
        event.preventDefault()
        add(files)
      }
    },
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    },
    onDrop: (event: DragEvent) => {
      const files = imageFilesOf(event.dataTransfer)
      if (files.length > 0) {
        event.preventDefault()
        add(files)
      }
    }
  }
  return { images, uploading, add, remove, setImages, handlers }
}

// The ＋ at the start of the row under the input: a menu of what can go into the message, which
// for now is images; the picker it opens takes several at once.
export function ChatAddMenu({ disabled, onAdd }: { disabled?: boolean; onAdd: (files: File[]) => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const input = useRef<HTMLInputElement>(null)
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="chat-add-button"
        aria-label="添加内容"
        data-tooltip="添加图片"
        data-tooltip-side="top"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon />
      </button>
      {open && (
        <Popover label="添加内容" onClose={close}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              input.current?.click()
            }}
          >
            <ImageIcon />
            <span className="menu-item-title">添加图片</span>
          </button>
          <div className="menu-label">也可以直接粘贴或拖进输入框</div>
        </Popover>
      )}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={IMAGE_MIME_TYPES.join(',')}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          // Cleared so choosing the same file again still fires a change.
          event.target.value = ''
          if (files.length > 0) onAdd(files)
        }}
      />
    </span>
  )
}

// Every thumbnail can be opened or copied; one in the composer can also be removed.
function Thumb({ image, onOpen, onRemove }: { image: ChatImage; onOpen: () => void; onRemove?: () => void }) {
  const url = useImageUrl(image.id)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="chat-image">
      <button type="button" className="chat-image-button" aria-label="查看图片" style={{ aspectRatio: `${image.width} / ${image.height}` }} onClick={onOpen}>
        {url && <img src={url} alt="" draggable={false} />}
      </button>
      <span className="chat-image-actions">
        <button type="button" className="chat-image-action" aria-label="放大" data-tooltip="放大" onClick={onOpen}>
          <SearchIcon />
        </button>
        <button
          type="button"
          className="chat-image-action"
          data-copied={copied || undefined}
          aria-label={copied ? '已复制' : '复制图片'}
          data-tooltip={copied ? '已复制' : '复制图片'}
          disabled={!url}
          onClick={() => {
            if (!url) return
            void copyImageToClipboard(url).then(
              () => setCopied(true),
              () => useCore.setState({ error: '图片复制失败' })
            )
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        {onRemove && (
          <button type="button" className="chat-image-action" aria-label="删除" data-tooltip="删除" onClick={onRemove}>
            <CloseIcon />
          </button>
        )}
      </span>
    </span>
  )
}

// A row of small thumbnails, each opening the viewer: a message's images, or the composer's with
// their actions on each.
export function ChatImageStrip({ images, uploading = 0, onRemove }: { images: readonly ChatImage[]; uploading?: number; onRemove?: (id: string) => void }) {
  const [viewing, setViewing] = useState<number | null>(null)
  if (images.length === 0 && uploading === 0) return null
  return (
    <>
      <div className="chat-images">
        {images.map((image, index) => (
          <Thumb key={image.id} image={image} onOpen={() => setViewing(index)} onRemove={onRemove && (() => onRemove(image.id))} />
        ))}
        {uploading > 0 && <span className="image-uploading" role="status">正在上传 {uploading} 张…</span>}
      </div>
      {viewing !== null && images.length > 0 && (
        <ImageViewer
          images={images.map((image) => ({ ...image, name: '' }))}
          index={Math.min(viewing, images.length - 1)}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}
