const BEFORE = 20
const AFTER = 60

// The match with a little context either side, on one line.
export function searchSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const needle = query.replace(/\s+/g, ' ')
  const at = Math.max(0, flat.toLowerCase().indexOf(needle.toLowerCase()))
  const start = Math.max(0, at - BEFORE)
  const end = Math.min(flat.length, at + needle.length + AFTER)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
