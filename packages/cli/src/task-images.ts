import { lstatSync } from 'node:fs'
import path from 'node:path'
import { imageLabel, type SnapshotImagePath, type Task } from '@kando/protocol'

// Where a stored image sits on this machine; null once it is gone (or is not a plain file).
export function attachmentPath(dir: string, id: string): string | null {
  const file = path.join(dir, id)
  try {
    return lstatSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

export function taskImageLines(task: Task, dir: string): string[] {
  return task.images.map((image, index) => `- ${imageLabel(image, index)}：${attachmentPath(dir, image.id) ?? '（图片已丢失）'}`)
}

export function snapshotImagePaths(task: Task, dir: string): SnapshotImagePath[] {
  return (task.sourceSnapshot?.images ?? []).map((image) => ({ name: image.name, path: attachmentPath(dir, image.id) }))
}
