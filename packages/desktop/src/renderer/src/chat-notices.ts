import { CONTEXT_COMPACTED, cursorProviderError } from '@kando/protocol'

export function isCompaction(text: string): boolean {
  return text === CONTEXT_COMPACTED
}

// Claude Code once said when a usage limit lifts only as epoch seconds after a bar; say the local
// time instead.
export function readableNotice(text: string): string {
  const provider = cursorProviderError(text.trim())
  if (provider && !provider.rest) return provider.summary
  return text.replace(/Claude AI usage limit reached\|(\d{10})/g, (_match, seconds: string) => {
    const at = new Date(Number(seconds) * 1000)
    const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
    const sameDay = at.toDateString() === new Date().toDateString()
    return `Claude 的用量到了上限，${sameDay ? '' : `${at.getMonth() + 1}月${at.getDate()}日 `}${time} 恢复`
  })
}

// A notice longer than a line opens onto the rest.
export function noticeSummary(text: string): { first: string; more: boolean } {
  const [first = '', ...rest] = text.split('\n')
  const long = first.length > 160
  return { first: long ? `${first.slice(0, 160)}…` : first, more: long || rest.some((line) => line.trim() !== '') }
}
