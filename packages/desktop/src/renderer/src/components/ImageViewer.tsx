import { useEffect, useId, useRef, useState } from 'react'
import { imageLabel, MAX_IMAGE_NAME_LENGTH, type TaskImage } from '@kando/protocol'
import { useImageUrl } from '../attachment-images'

// One image at full size, with the neighbours a keypress away. `onRename` makes the name
// editable; without it (an issue's images) the viewer is read-only.
export function ImageViewer({
  images,
  index,
  note,
  onIndex,
  onClose,
  onRename
}: {
  images: readonly TaskImage[]
  index: number
  note?: string
  onIndex: (index: number) => void
  onClose: () => void
  onRename?: (id: string, name: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const ids = useId()
  const image = images[index]
  const url = useImageUrl(image?.id ?? '')
  const [name, setName] = useState(image?.name ?? '')

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    return () => element?.close()
  }, [])

  useEffect(() => {
    setName(image?.name ?? '')
  }, [image?.id, image?.name])

  if (!image) {
    return null
  }
  const go = (step: number) => onIndex((index + step + images.length) % images.length)
  const commitName = () => {
    if (onRename && name.trim() !== image.name) {
      onRename(image.id, name.trim())
    }
  }

  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-labelledby={`${ids}-title`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => event.target === dialog.current && onClose()}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) {
          return
        }
        if (event.key === 'ArrowLeft') {
          go(-1)
        } else if (event.key === 'ArrowRight') {
          go(1)
        }
      }}
    >
      <header className="image-viewer-header">
        <span id={`${ids}-title`} className="image-viewer-title">
          {imageLabel({ name: '' }, index)}
          <span className="muted"> / {images.length}</span>
        </span>
        {onRename ? (
          <input
            className="input image-viewer-name"
            value={name}
            placeholder="给图片起个名字（可选）"
            maxLength={MAX_IMAGE_NAME_LENGTH}
            aria-label="图片名字"
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        ) : (
          <span className="image-viewer-name-static">{image.name}</span>
        )}
        {note && <span className="muted image-viewer-note">{note}</span>}
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="image-viewer-stage">
        {images.length > 1 && (
          <button type="button" className="image-viewer-step" aria-label="上一张" onClick={() => go(-1)}>
            ‹
          </button>
        )}
        {url ? <img src={url} alt={image.name || imageLabel(image, index)} /> : <span className="muted">正在加载…</span>}
        {images.length > 1 && (
          <button type="button" className="image-viewer-step" aria-label="下一张" onClick={() => go(1)}>
            ›
          </button>
        )}
      </div>
      <footer className="image-viewer-footer muted">
        {image.width} × {image.height}
      </footer>
    </dialog>
  )
}
