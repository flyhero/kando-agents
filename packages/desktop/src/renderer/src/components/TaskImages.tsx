import { useState, type ClipboardEvent, type DragEvent } from 'react'
import type { Task } from '@kando/protocol'
import { imageFilesOf, uploadImageFiles } from '../attachment-images'
import { perform } from '../core-store'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'

// Adding images to a task from anywhere on its page: the picker, a paste, a drop.
export function useImageAdder(taskId: string) {
  const [uploading, setUploading] = useState(0)
  const add = async (files: File[]) => {
    setUploading((count) => count + files.length)
    const images = await uploadImageFiles(files)
    setUploading((count) => count - files.length)
    if (images.length > 0) {
      await perform((rpc) => rpc.call('tasks.addImages', { id: taskId, images: images.map(({ id, name }) => ({ id, name })) }))
    }
  }
  // Only a clipboard or drag that carries image files is taken; text goes where it was going.
  const handlers = {
    onPaste: (event: ClipboardEvent) => {
      const files = imageFilesOf(event.clipboardData)
      if (files.length > 0) {
        event.preventDefault()
        void add(files)
      }
    },
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes('Files')) {
        event.preventDefault()
      }
    },
    onDrop: (event: DragEvent) => {
      const files = imageFilesOf(event.dataTransfer)
      if (files.length > 0) {
        event.preventDefault()
        void add(files)
      }
    }
  }
  return { uploading, add, handlers }
}

export function TaskImages({ task, uploading, onAddFiles }: { task: Task; uploading: number; onAddFiles: (files: File[]) => void }) {
  const [viewing, setViewing] = useState<number | null>(null)
  return (
    <>
      <ImageStrip
        images={task.images}
        uploading={uploading}
        onOpen={setViewing}
        onAddFiles={onAddFiles}
        onRemove={(attachmentId) => void perform((rpc) => rpc.call('tasks.removeImage', { id: task.id, attachmentId }))}
      />
      {viewing !== null && task.images.length > 0 && (
        <ImageViewer
          images={task.images}
          index={Math.min(viewing, task.images.length - 1)}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          onRename={(attachmentId, name) =>
            void perform((rpc) => rpc.call('tasks.updateImage', { id: task.id, attachmentId, name }))
          }
        />
      )}
    </>
  )
}
