import type { ChatItem } from '@kando/protocol'
import { formatClock, useNow } from '../usage-format'

export type UsageLimitItem = Extract<ChatItem, { kind: 'usageLimit' }>

// What became of a turn the usage limit stopped, in the conversation's flow: one line, as a
// request's is, saying when it goes on or went on.
export function usageLimitText(item: UsageLimitItem, now: number): string {
  switch (item.status) {
    case 'retrying':
      return '额度已用完 · 正在继续…'
    case 'continued':
      return item.continuedAt === null ? '额度已用完 · 已继续' : `额度已用完 · 已于${formatClock(item.continuedAt, now)} 继续`
    case 'waiting':
      if (item.autoContinue && item.continueAt !== null) return `额度已用完 · 将在${formatClock(item.continueAt, now)} 自动继续`
  }
  return item.resetsAt === null ? '额度已用完' : `额度已用完 · ${formatClock(item.resetsAt, now)} 恢复`
}

export function ChatUsageLimitLine({ item }: { item: UsageLimitItem }) {
  const now = useNow(60_000)
  const waiting = item.status === 'waiting' && item.autoContinue
  return (
    <div className="chat-request-line" data-waiting={waiting || undefined}>
      {usageLimitText(item, now)}
    </div>
  )
}
