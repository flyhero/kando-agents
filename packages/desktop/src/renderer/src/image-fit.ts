// Claude's API takes an image up to 5MB and scales one past 1568px on a side down itself, so a
// large screenshot going into a chat is shrunk here first: nothing the model would see is lost.
// A task's images are read by the agent's own file tool, which copes with size by itself.
const MAX_SIDE = 2000
const MAX_BYTES = 4 * 1024 * 1024

export async function fitChatImage(file: File): Promise<File> {
  // Redrawing a GIF would drop its frames.
  if (file.size <= MAX_BYTES || file.type === 'image/gif') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // PNG keeps a screenshot crisp; a photo that stays large goes as JPEG, losing any transparency.
  const png = await canvas.convertToBlob({ type: 'image/png' })
  const blob = png.size <= MAX_BYTES ? png : await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  if (blob.size >= file.size) return file
  const name = `${file.name.replace(/\.[^.]+$/, '') || 'image'}.${blob.type === 'image/png' ? 'png' : 'jpg'}`
  return new File([blob], name, { type: blob.type })
}
