import { useState } from 'react'
import type { Conversation } from '@kando/protocol'
import { perform } from '../core-store'
import { continueConversation } from './ConversationActions'

// One message at a time: the box takes the next one while the agent works, and sends once it is idle.
export function ChatComposer({ conversation }: { conversation: Conversation }) {
  const { id } = conversation
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const running = conversation.sessionId !== null && conversation.mode === 'chat'
  const turn = conversation.chat?.turn ?? null
  const idle = running && turn === 'idle'
  const send = async () => {
    const value = text.trim()
    if (!value || !idle || busy) return
    setBusy(true)
    const sent = await perform((rpc) => rpc.call('conversations.send', { id, text: value }))
    setBusy(false)
    if (sent) setText('')
  }
  if (!running) {
    return (
      <div className="chat-composer chat-composer-stopped">
        <span className="muted">agent 没有在运行</span>
        <button type="button" className="button primary" onClick={() => void continueConversation(id, 'chat')}>以聊天界面继续</button>
      </div>
    )
  }
  return (
    <div className="chat-composer">
      <textarea
        className="input chat-input"
        rows={3}
        value={text}
        aria-label="给 agent 的消息"
        placeholder={idle ? '给 agent 发消息，Enter 发送，Shift+Enter 换行' : turn === 'awaiting' ? '先在上面回答 agent 的请求' : 'agent 正在处理，可以先写下一条'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter while an input method is composing picks a candidate; it is not a send.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="chat-composer-actions">
        {!idle && (
          <button type="button" className="button ghost" onClick={() => void perform((rpc) => rpc.call('conversations.interrupt', { id }))}>
            中断
          </button>
        )}
        <button type="button" className="button primary" disabled={!idle || busy || !text.trim()} onClick={() => void send()}>
          发送
        </button>
      </div>
    </div>
  )
}
