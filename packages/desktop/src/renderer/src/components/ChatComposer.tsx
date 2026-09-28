import { useState } from 'react'
import type { ChatItem, Conversation } from '@kando/protocol'
import { perform, useChatOptionsSupported } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { continueConversation } from './ConversationActions'
import { EnterIcon, StopIcon } from './icons'

type Queued = NonNullable<Extract<ChatItem, { kind: 'state' }>['queued']>

// The message waiting for the turn to end, or one an interrupted turn held back.
function QueuedMessage({ queued, onEdit, onSend, onCancel }: { queued: Queued; onEdit: () => void; onSend: () => void; onCancel: () => void }) {
  return (
    <div className="chat-queued" data-held={queued.held || undefined}>
      <span className="chat-queued-label">{queued.held ? '上一回合没有完成，这条还没发：' : '回合结束后发送：'}</span>
      <span className="chat-queued-text">{queued.text}</span>
      <span className="chat-queued-actions">
        {queued.held && <button type="button" className="link-button" onClick={onSend}>发送</button>}
        <button type="button" className="link-button" onClick={onEdit}>编辑</button>
        <button type="button" className="link-button" onClick={onCancel}>取消</button>
      </span>
    </div>
  )
}

// Enter sends when the agent is idle; while it works, Enter queues the message for when the turn
// ends (a second one joins the first). With no agent running, it starts one on the same session
// first. The corner button sends, or stops the turn.
export function ChatComposer({ conversation, queued }: { conversation: Conversation; queued: Queued | null }) {
  const { id } = conversation
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const running = conversation.sessionId !== null && conversation.mode === 'chat'
  const turn = conversation.chat?.turn ?? null
  const idle = running && turn === 'idle'
  const working = running && (turn === 'running' || turn === 'awaiting')
  // An older core takes a message only between turns.
  const queueable = useChatOptionsSupported() && working
  const stopped = !running
  const starting = stopped && busy
  const canSend = (idle || queueable || stopped) && !busy && text.trim() !== ''
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    const message = !queueable || !queued ? text.trim() : `${queued.text}\n\n${text.trim()}`
    // Continuing resolves once the agent is ready; if it fails, the text stays to try again.
    const ready = stopped ? await continueConversation(id, 'chat') : true
    const sent = ready && await perform((rpc) => rpc.call('conversations.send', { id, text: message, ...(queueable ? { queue: true } : {}) }))
    setBusy(false)
    if (sent) setText('')
  }
  const cancelQueued = () => perform((rpc) => rpc.call('conversations.cancelQueued', { id }))
  const editQueued = async () => {
    if (!queued) return
    const pulled = queued.text
    if (await cancelQueued()) setText((current) => (current.trim() ? `${pulled}\n\n${current}` : pulled))
  }
  const interrupt = () => void perform((rpc) => rpc.call('conversations.interrupt', { id }))
  return (
    <>
    {queued && (
      <QueuedMessage
        queued={queued}
        onEdit={() => void editQueued()}
        onSend={() => void perform((rpc) => rpc.call('conversations.sendQueued', { id }))}
        onCancel={() => void cancelQueued()}
      />
    )}
    <div className="chat-input-card" data-working={working || starting || undefined} data-awaiting={turn === 'awaiting' || undefined}>
      <textarea
        className="chat-input"
        rows={3}
        value={text}
        aria-label="给 agent 的消息"
        readOnly={starting}
        placeholder={
          idle || stopped ? '给 agent 发消息，Enter 发送，Shift+Enter 换行'
            : queueable ? `${turn === 'awaiting' ? '先回答上面的请求，' : ''}也可以写下一条，Enter 排到回合结束后发送；Esc 中断`
            : turn === 'awaiting' ? '先回答上面的请求' : 'agent 正在处理，可以先写下一条；Esc 中断'
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter while an input method is composing picks a candidate; it is not a send.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          } else if (event.key === 'Escape' && working && !event.nativeEvent.isComposing) {
            event.preventDefault()
            interrupt()
          }
        }}
      />
      {working ? (
        <button type="button" className="chat-input-button" data-stop aria-label="中断这一回合（Esc）" data-tooltip="中断（Esc）" onClick={interrupt}>
          <StopIcon />
        </button>
      ) : (
        <button type="button" className="chat-input-button" aria-label="发送（Enter）" data-tooltip={starting ? `正在启动 ${AGENT_LABEL[conversation.agent]}…` : '发送（Enter）'} disabled={!canSend} onClick={() => void send()}>
          <EnterIcon />
        </button>
      )}
    </div>
    </>
  )
}
