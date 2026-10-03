import { create } from 'zustand'

// A passage of the agent's reply the user quotes in their next message, with what they say about
// it. source is the entry it came from, to find it again; null when it is not known.
export type ChatQuote = { id: string; source: string | null; text: string; note: string }

// The passages waiting in each chat's input, in the order they were picked.
const useQuoteStore = create<Record<string, readonly ChatQuote[]>>()(() => ({}))

let nextId = 0

export function useQuotes(conversationId: string): readonly ChatQuote[] {
  return useQuoteStore((s) => s[conversationId] ?? NONE)
}

const NONE: readonly ChatQuote[] = []

function update(conversationId: string, change: (quotes: readonly ChatQuote[]) => readonly ChatQuote[]): void {
  useQuoteStore.setState((s) => ({ [conversationId]: change(s[conversationId] ?? NONE) }))
}

export function addQuote(conversationId: string, source: string | null, text: string): void {
  const clean = text.trim()
  if (!clean) return
  update(conversationId, (quotes) => [...quotes, { id: `q${++nextId}`, source, text: clean, note: '' }])
}

export function setQuoteNote(conversationId: string, id: string, note: string): void {
  update(conversationId, (quotes) => quotes.map((quote) => (quote.id === id ? { ...quote, note } : quote)))
}

export function removeQuote(conversationId: string, id: string): void {
  update(conversationId, (quotes) => quotes.filter((quote) => quote.id !== id))
}

export function setQuotes(conversationId: string, quotes: readonly Omit<ChatQuote, 'id'>[]): void {
  update(conversationId, () => quotes.map((quote) => ({ ...quote, id: `q${++nextId}` })))
}

// A quote opens with a marker the agent reads past and the chat finds the passage by, then the
// passage as a Markdown quote, then the note, a line apart; two empty lines end it.
//
//   <!-- quote 1 from item:stage/reply -->
//   > what the agent said
//
//   what the user says about it
//
//
//   the message itself
const MARKER = /^<!-- quote (\d+)(?: from (\S+))? -->$/

export function composeMessage(quotes: readonly Pick<ChatQuote, 'source' | 'text' | 'note'>[], body: string): string {
  const blocks = quotes.map((quote, index) => {
    const marker = `<!-- quote ${index + 1}${quote.source && !quote.source.includes('-->') ? ` from ${quote.source}` : ''} -->`
    const passage = quote.text.trim().split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')
    const note = quote.note.replace(/\s*\n\s*/g, ' ').trim()
    return [marker, passage, ...(note ? ['', note] : [])].join('\n')
  })
  return [...blocks, body.trim()].filter(Boolean).join('\n\n\n')
}

// The quotes a message opens with, and the rest of it. A message that does not open with a
// marker is all body, Markdown quotes and all.
export function parseQuotes(message: string): { quotes: Omit<ChatQuote, 'id'>[]; body: string } {
  const lines = message.split('\n')
  const quotes: Omit<ChatQuote, 'id'>[] = []
  let at = 0
  while (at < lines.length) {
    const marker = MARKER.exec(lines[at]?.trim() ?? '')
    if (!marker) break
    at++
    const passage: string[] = []
    while (at < lines.length && lines[at]?.startsWith('>')) {
      passage.push((lines[at] ?? '').replace(/^> ?/, ''))
      at++
    }
    let blank = 0
    while (at < lines.length && lines[at]?.trim() === '') {
      blank++
      at++
    }
    // One empty line before a line that opens no quote: that line is the note.
    let note = ''
    if (blank === 1 && at < lines.length && !MARKER.test(lines[at]?.trim() ?? '')) {
      note = lines[at]?.trim() ?? ''
      at++
      while (at < lines.length && lines[at]?.trim() === '') at++
    }
    quotes.push({ source: marker[2] ?? null, text: passage.join('\n').trim(), note })
  }
  if (quotes.length === 0) return { quotes, body: message }
  return { quotes, body: lines.slice(at).join('\n').trim() }
}

// A message as the user would copy it: the quotes as Markdown, without the markers.
export function withoutQuoteMarkers(message: string): string {
  return message.split('\n').filter((line) => !MARKER.test(line.trim())).join('\n').trim()
}
