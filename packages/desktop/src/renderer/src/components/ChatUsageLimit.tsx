import { useState } from 'react'
import { quotaVerdict, type ChatItem, type Conversation } from '@kando/protocol'
import { otherInstalledAgent, useInstalledAgents } from '../installed-agents'
import { perform, useCore, useUsageLimitSupported } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { formatClock, useNow } from '../usage-format'
import { useChatSurface } from './chat-surface'

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

// While the chat waits on a usage limit, in the flow right after the turn it stopped. It does not
// take the composer's place as a request does: writing to the agent is still how the user goes on
// another way, and that drops the wait.
export function ChatUsageLimitCard({ conversation, item }: { conversation: Conversation; item: UsageLimitItem }) {
  const surface = useChatSurface()
  const supported = useUsageLimitSupported()
  const now = useNow(30_000)
  const [busy, setBusy] = useState(false)
  // What the user just ticked, shown until core's word on it comes back with the item.
  const [wanted, setWanted] = useState<boolean | null>(null)
  const other = otherInstalledAgent(conversation.agent, useInstalledAgents())
  const otherUsage = useCore((s) => (other ? s.usage?.[other] : undefined))
  if (!supported) return null
  const otherState = quotaVerdict(otherUsage, now).state
  // Handing off goes to the other agent only while it has room to take the work.
  const handoff = surface.handoff && other && (otherState === 'ok' || otherState === 'tight') ? surface.handoff : null
  const target = { id: conversation.id, stageId: item.stageId, itemId: item.id }
  const retrying = busy || item.status === 'retrying'
  const toggle = async (autoContinue: boolean) => {
    setWanted(autoContinue)
    await perform((rpc) => rpc.call('conversations.setUsageLimitAutoContinue', { ...target, autoContinue }))
    setWanted(null)
  }
  const retry = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.retryUsageLimit', target))
    setBusy(false)
  }
  const detail = retrying
    ? '正在重试…'
    : item.autoContinue && item.continueAt !== null
      ? `将在${formatClock(item.continueAt, now)} 自动继续`
      : item.resetsAt !== null
        ? `额度将在${formatClock(item.resetsAt, now)} 恢复`
        : '还不知道额度什么时候恢复'
  return (
    <div className="chat-request chat-usage-limit" role="status">
      <div className="chat-request-title">会话额度已用完</div>
      <p className="chat-request-detail muted">{detail}</p>
      {item.error && !retrying && <p className="chat-request-detail chat-usage-limit-error">上次没能继续：{item.error}</p>}
      <div className="chat-request-actions">
        <label className="conversation-confirm">
          <input type="checkbox" checked={wanted ?? item.autoContinue} disabled={retrying} onChange={(event) => void toggle(event.target.checked)} />
          额度恢复后自动继续
        </label>
        <span className="chat-dock-spacer" />
        {handoff && other && (
          <button type="button" className="button" disabled={retrying} data-tooltip={`移交给 ${AGENT_LABEL[other]}`} onClick={handoff}>
            立即移交
          </button>
        )}
        <button type="button" className="button primary" disabled={retrying} onClick={() => void retry()}>
          {retrying ? '正在重试…' : '立即重试'}
        </button>
      </div>
    </div>
  )
}

// In the conversation's flow: the card while the chat waits on the limit, then the line it leaves.
export function ChatUsageLimitEntry({ conversationId, item }: { conversationId: string; item: UsageLimitItem }) {
  const conversation = useCore((s) => s.conversations[conversationId])
  const supported = useUsageLimitSupported()
  const open = item.status === 'waiting' || item.status === 'retrying'
  return conversation && supported && open ? <ChatUsageLimitCard conversation={conversation} item={item} /> : <ChatUsageLimitLine item={item} />
}
