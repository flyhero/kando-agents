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
