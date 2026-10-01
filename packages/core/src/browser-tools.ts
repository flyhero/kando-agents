import { type BrowserToolKind } from '@kando/protocol'

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const short = (text: string, max = 40): string => (text.length > max ? `${text.slice(0, max)}…` : text)

// One line saying what a browser tool call does, for its card: the URL, the element and what
// goes into it, the key. Shared by both drivers, since the tools are Kando's own.
export function describeBrowserTool(kind: BrowserToolKind, input: Record<string, unknown>): string {
  const ref = str(input.ref) ?? ''
  switch (kind) {
    case 'navigate':
      return str(input.url) ?? str(input.history) ?? ''
    case 'click':
    case 'hover':
      return ref
    case 'type': {
      const text = str(input.text)
      return text ? `${ref} · 「${short(text.split('\n')[0] ?? '')}」` : ref
    }
    case 'press':
      return str(input.key) ?? ''
    case 'select':
      return Array.isArray(input.values) ? `${ref} · ${input.values.map(String).join(', ')}` : ref
    case 'scroll': {
      const direction = str(input.direction) ?? ''
      return ref ? `${ref} · ${direction}` : direction
    }
    case 'wait': {
      if (typeof input.seconds === 'number') return `${input.seconds} s`
      return str(input.text) ?? str(input.textGone) ?? ''
    }
    case 'tabs': {
      const action = str(input.action) ?? ''
      return [action, str(input.url) ?? str(input.tabId)].filter(Boolean).join(' · ')
    }
    case 'snapshot':
    case 'screenshot':
    case 'console':
      return ''
  }
}

// Whether the call's arguments are worth a line of their own under the title.
export function showBrowserInput(kind: BrowserToolKind): boolean {
  return kind === 'type' || kind === 'select' || kind === 'screenshot' || kind === 'console'
}
