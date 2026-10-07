import type { WireDirection, WireEntry } from '@kando/protocol'

// Which way an entry went, as the list marks it: → to the agent, ← from it.
export const WIRE_MARK: Record<WireDirection, string> = { spawn: '▶', stdin: '→', stdout: '←', stderr: '!', exit: '■', note: '·' }
export const WIRE_DIR_LABEL: Record<WireDirection, string> = { spawn: '启动', stdin: '发给 Agent', stdout: 'Agent 输出', stderr: 'stderr', exit: '退出', note: '说明' }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

function word(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

// The entry's text as JSON, or null when it is not.
export function wireJson(entry: WireEntry): unknown {
  if (entry.dir === 'stderr' || entry.dir === 'note' || entry.cut !== undefined) return null
  const text = entry.text.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// What a frame is, in a few words: Claude's type and subtype (or what a control frame or stream
// event carries), a JSON-RPC method and id for Codex, the start of the line for anything else.
export function wireLabel(entry: WireEntry): string {
  const json = record(wireJson(entry))
  if (entry.dir === 'spawn') {
    const command = word(json?.command)
    return command ? `启动 ${command.split(/[\\/]/).at(-1)}` : '启动'
  }
  if (entry.dir === 'exit') return json && 'code' in json ? `退出，代码 ${String(json.code)}` : '退出'
  if (!json) return firstLine(entry.text)
  const method = word(json.method)
  if (method) return 'id' in json ? `${method} #${String(json.id)}` : method
  if ('id' in json && ('result' in json || 'error' in json)) return `${'error' in json ? 'error' : 'result'} #${String(json.id)}`
  const type = word(json.type)
  if (!type) return 'JSON'
  const inner = record(json.request) ?? record(json.response) ?? record(json.event)
  const detail = word(json.subtype) ?? word(inner?.subtype) ?? word(inner?.type)
  return detail ? `${type} · ${detail}` : type
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

// Streamed pieces of text and keep-alives: many, and seldom what one looks for.
export function isWireStream(entry: WireEntry): boolean {
  if (entry.dir !== 'stdout') return false
  const json = record(wireJson(entry))
  if (!json) return false
  const method = word(json.method)
  if (method) return /delta$/i.test(method)
  return json.type === 'stream_event' || json.type === 'keep_alive'
}

// A row of the list: an entry, or a run of streamed pieces folded into one.
export type WireRow = { kind: 'entry'; entry: WireEntry } | { kind: 'stream'; entries: WireEntry[] }

// Streamed pieces in a row fold into one: they come by the hundred, and together are mostly one
// reply. A piece on its own stays a row of its own.
export function groupWireEntries(entries: readonly WireEntry[]): WireRow[] {
  const rows: WireRow[] = []
  let run: WireEntry[] = []
  const close = () => {
    if (run.length > 1) rows.push({ kind: 'stream', entries: run })
    else run.forEach((entry) => rows.push({ kind: 'entry', entry }))
    run = []
  }
  for (const entry of entries) {
    if (isWireStream(entry)) {
      run.push(entry)
    } else {
      close()
      rows.push({ kind: 'entry', entry })
    }
  }
  close()
  return rows
}

// What a streamed piece adds: Claude's text, thinking or tool input, Codex's delta.
function pieceText(entry: WireEntry): string {
  const json = record(wireJson(entry))
  if (!json) return ''
  const codex = word(record(json.params)?.delta)
  if (codex) return codex
  const delta = record(record(json.event)?.delta)
  return word(delta?.text) ?? word(delta?.thinking) ?? word(delta?.partial_json) ?? ''
}

// The streamed pieces' text, joined as the agent wrote it.
export function streamText(entries: readonly WireEntry[]): string {
  return entries.map(pieceText).join('')
}

export function streamLabel(entries: readonly WireEntry[]): string {
  const text = streamText(entries).replace(/\s+/g, ' ').trim()
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
  return `流式增量 × ${entries.length}${preview ? ` · ${preview}` : ''}`
}

export function totalSize(entries: readonly WireEntry[]): string {
  const encoder = new TextEncoder()
  return formatBytes(entries.reduce((sum, entry) => sum + encoder.encode(entry.text).length, 0))
}

export function wireMatches(entry: WireEntry, needle: string): boolean {
  return needle === '' || entry.text.toLowerCase().includes(needle) || wireLabel(entry).toLowerCase().includes(needle)
}

// What the expanded entry shows and copies: JSON laid out, anything else as it came.
export function wireDetail(entry: WireEntry): string {
  const json = wireJson(entry)
  const text = json === null ? entry.text : JSON.stringify(json, null, 2)
  return entry.cut === undefined ? text : `${text}\n…（原本 ${entry.cut.toLocaleString()} 个字符，只记了前面这些）`
}

export function wireSize(entry: WireEntry): string {
  return formatBytes(new TextEncoder().encode(entry.text).length)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function wireTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

// Entries as they arrive, merged into those held: by position, each once.
export function mergeWireEntries(held: readonly WireEntry[], added: readonly WireEntry[]): WireEntry[] {
  const last = held.at(-1)?.pos ?? -1
  const fresh = added.filter((entry) => entry.pos > last)
  return fresh.length ? [...held, ...fresh] : [...held]
}

// The entries as a .jsonl, one per line as the log keeps them, for pasting into a bug report.
export function wireJsonl(entries: readonly WireEntry[]): string {
  return entries.map((entry) => JSON.stringify({ at: entry.at, dir: entry.dir, text: entry.text, ...(entry.cut !== undefined ? { cut: entry.cut } : {}) })).join('\n')
}
