import { useState } from 'react'
import type { Conversation } from '@kando/protocol'
import { perform } from '../core-store'
import { continueConversation } from './ConversationActions'
import { EnterIcon, StopIcon } from './icons'

// One message at a time: the box takes the next one while the agent works, and sends once it is
// idle. Its corner button sends when the agent is idle and stops the turn while it works.
export function ChatComposer({ conversation }: { conversation: Conversation }) {
  const { id } = conversation
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const running = conversation.sessionId !== null && conversation.mode === 'chat'
  const turn = conversation.chat?.turn ?? null
  const idle = running && turn === 'idle'
  const working = running && (turn === 'running' || turn === 'awaiting')
  const canSend = idle && !busy && text.trim() !== ''
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    const sent = await perform((rpc) => rpc.call('conversations.send', { id, text: text.trim() }))
    setBusy(false)
    if (sent) setText('')
  }
  const interrupt = () => void perform((rpc) => rpc.call('conversations.interrupt', { id }))
  if (!running) {
    return (
      <div className="chat-composer-stopped">
        <span className="muted">agent 没有在运行</span>
        <button type="button" className="button primary" onClick={() => void continueConversation(id, 'chat')}>以聊天界面继续</button>
      </div>
    )
  }
  return (
    <div className="chat-input-card" data-working={working || undefined} data-awaiting={turn === 'awaiting' || undefined}>
      <textarea
        className="chat-input"
        rows={3}
        value={text}
        aria-label="给 agent 的消息"
        placeholder={idle ? '给 agent 发消息，Enter 发送，Shift+Enter 换行' : turn === 'awaiting' ? '先回答上面的请求' : 'agent 正在处理，可以先写下一条；Esc 中断'}
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
        <button type="button" className="chat-input-button" aria-label="发送（Enter）" data-tooltip="发送（Enter）" disabled={!canSend} onClick={() => void send()}>
          <EnterIcon />
        </button>
      )}
    </div>
  )
}
