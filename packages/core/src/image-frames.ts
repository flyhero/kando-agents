import { imageMarker, type ChatImage } from '@kando/protocol'

// An image block as either agent carries one: Claude {type:'image', source:{data}}, Codex and MCP
// {type:'image', data}. The bytes are in the attachment store (see imageMarker), so the log keeps
// the block's shape with the data emptied, and a replay reads the same frame minus the picture.
export function stripImageBytes(frame: unknown): unknown {
  if (Array.isArray(frame)) {
    let changed = false
    const stripped = frame.map((entry) => {
      const next = stripImageBytes(entry)
      if (next !== entry) changed = true
      return next
    })
    return changed ? stripped : frame
  }
  if (!frame || typeof frame !== 'object') return frame
  const record: Record<string, unknown> = { ...frame }
  let changed = false
  if (record.type === 'image') {
    if (typeof record.data === 'string' && record.data !== '') {
      record.data = ''
      changed = true
    }
    const source = record.source
    if (source && typeof source === 'object' && 'data' in source && typeof source.data === 'string' && source.data !== '') {
      record.source = { ...source, data: '' }
      changed = true
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const next = stripImageBytes(value)
    if (next !== value) {
      record[key] = next
      changed = true
    }
  }
  return changed ? record : frame
}

// The bytes an image block carries, base64, in either shape (see stripImageBytes); null for any
// other block, or one already emptied.
export function imageBlockData(block: unknown): string | null {
  if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image') return null
  if ('data' in block && typeof block.data === 'string' && block.data !== '') return block.data
  const source = 'source' in block ? block.source : null
  return source && typeof source === 'object' && 'data' in source && typeof source.data === 'string' && source.data !== '' ? source.data : null
}

// Blocks with each image that carries bytes put in the store (keep, which says null for one it
// could not take), and the images it took in order.
export function keepImageBlocks(blocks: readonly unknown[], keep: (data: string) => ChatImage | null): ChatImage[] {
  return blocks.flatMap((block) => {
    const data = imageBlockData(block)
    const kept = data === null ? null : keep(data)
    return kept ? [kept] : []
  })
}

// The blocks as the log keeps them: each image the store took becomes the marker naming its copy,
// so a replay shows it as the live stage did, and the bytes stay out of the log.
export function markKeptImages(blocks: readonly unknown[], kept: readonly ChatImage[]): unknown[] {
  let next = 0
  return blocks.map((block) => {
    const image = imageBlockData(block) !== null ? kept[next] : undefined
    if (!image) return block
    next += 1
    return { type: 'text', text: imageMarker(image) }
  })
}
