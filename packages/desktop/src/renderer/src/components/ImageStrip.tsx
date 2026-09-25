import { useRef } from 'react'
import { IMAGE_MIME_TYPES, imageLabel, type TaskImage } from '@kando/protocol'
import { useImageUrl } from '../attachment-images'

function Thumbnail({
  image,
  index,
  onOpen,
  onRemove
}: {
  image: TaskImage
  index: number
  onOpen: () => void
  onRemove?: () => void
}) {
  const url = useImageUrl(image.id)
  const label = imageLabel(image, index)
  return (
    <figure className="image-thumb">
      <button type="button" className="image-thumb-button" aria-label={`查看${label}`} onClick={onOpen}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="image-thumb-placeholder" />}
        <span className="image-thumb-number" aria-hidden="true">
          {index + 1}
        </span>
      </button>
      <figcaption className="image-thumb-name" title={image.name || label}>
        {image.name || `图 ${index + 1}`}
      </figcaption>
      {onRemove && (
        <button type="button" className="image-thumb-remove" aria-label={`移除${label}`} data-tooltip="移除" onClick={onRemove}>
          ×
        </button>
      )}
    </figure>
  )
}

// A row of numbered thumbnails: the task's own images, or (read-only) an issue's.
export function ImageStrip({
  images,
  uploading = 0,
  onOpen,
  onAddFiles,
  onRemove
}: {
  images: readonly TaskImage[]
  uploading?: number
  onOpen: (index: number) => void
  onAddFiles?: (files: File[]) => void
  onRemove?: (id: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="image-strip">
      {images.map((image, index) => (
        <Thumbnail
          key={image.id}
          image={image}
          index={index}
          onOpen={() => onOpen(index)}
          onRemove={onRemove && (() => onRemove(image.id))}
        />
      ))}
      {uploading > 0 && (
        <span className="image-uploading" role="status">
          正在上传 {uploading} 张…
        </span>
      )}
      {onAddFiles && (
        <>
          <button
            type="button"
            className="chip chip-add-button"
            data-tooltip="也可以直接粘贴或拖进来"
            data-tooltip-align="start"
            onClick={() => input.current?.click()}
          >
            ＋ 添加图片
          </button>
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
              if (files.length > 0) {
                onAddFiles(files)
              }
            }}
          />
        </>
      )}
    </div>
  )
}
