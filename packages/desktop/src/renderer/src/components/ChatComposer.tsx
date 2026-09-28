import { useState, type KeyboardEvent } from 'react'
import type { ChatImage, ChatItem, Conversation } from '@kando/protocol'
import { perform, useChatImagesSupported, useChatOptionsSupported } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { useChatSurface } from './chat-surface'
import { ChatAddMenu, ChatImageStrip, useComposerImages } from './ChatImages'
import { ChatOptionsBar } from './ChatOptionsBar'
import { EnterIcon, StopIcon } from './icons'

// Enter sends and Shift+Enter breaks the line; Enter while an input method is composing picks a
// candidate instead.
export function sendsMessage(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

// Images from two sources in order, each once.
export function mergeImages(first: readonly ChatImage[], second: readonly ChatImage[]): ChatImage[] {
  const known = new Set(first.map((image) => image.id))
  return [...first, ...second.filter((image) => !known.has(image.id))]
}

type StateItem = Extract<ChatItem, { kind: 'state' }>
type Queued = NonNullable<StateItem['queued']>

// The message waiting for the turn to end, or one an interrupted turn held back.
function QueuedMessage({ queued, onEdit, onSend, onCancel }: { queued: Queued; onEdit: () => void; onSend: () => void; onCancel: () => void }) {
  return (
    <div className="chat-queued" data-held={queued.held || undefined}>
      <span className="chat-queued-label">{queued.held ? '上一回合没有完成，这条还没发：' : '回合结束后发送：'}</span>
      <span className="chat-queued-text">{queued.text}</span>
      {queued.images.length > 0 && <span className="chat-queued-images">{queued.images.length} 张图片</span>}
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
// first. The corner button sends, or stops the turn. Images pasted, dropped or picked from the ＋
// below sit above the text until it goes. `state` is the running stage's, for the options row.
export function ChatComposer({ conversation, state }: { conversation: Conversation; state: StateItem | null }) {
  const { id } = conversation
  const surface = useChatSurface()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const imagesSupported = useChatImagesSupported()
  const optionsSupported = useChatOptionsSupported()
  const attached = useComposerImages()
  const running = conversation.sessionId !== null && conversation.mode === 'chat'
  const queued = running ? (state?.queued ?? null) : null
  const turn = conversation.chat?.turn ?? null
  const idle = running && turn === 'idle'
  const working = running && (turn === 'running' || turn === 'awaiting')
  // An older core takes a message only between turns.
  const queueable = optionsSupported && working
  const stopped = !running
  const starting = stopped && busy
  const canSend = (idle || queueable || stopped) && !busy && !surface.sendBlocker && attached.uploading === 0 && (text.trim() !== '' || attached.images.length > 0)
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    const joined = queueable && queued
    const message = !joined ? text.trim() : [queued.text, text.trim()].filter(Boolean).join('\n\n')
    const images = joined ? mergeImages(queued.images, attached.images) : attached.images
    // Getting ready resolves once the agent can take it; if that fails, the text stays to try again.
    const ready = await surface.prepareSend(stopped)
    const sent = ready && await perform((rpc) => rpc.call('conversations.send', {
      id,
      text: message,
      ...(images.length ? { images: images.map((image) => image.id) } : {}),
      ...(queueable ? { queue: true } : {})
    }))
    setBusy(false)
    if (sent) {
      setText('')
      attached.setImages([])
    }
  }
  const cancelQueued = () => perform((rpc) => rpc.call('conversations.cancelQueued', { id }))
  const editQueued = async () => {
    if (!queued) return
    const pulled = queued
    if (await cancelQueued()) {
      setText((current) => [pulled.text, current].filter((part) => part.trim()).join('\n\n'))
      attached.setImages((current) => mergeImages(pulled.images, current))
    }
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
    <div
      className="chat-input-card"
      data-working={working || starting || undefined}
      data-awaiting={turn === 'awaiting' || undefined}
      onDragOver={imagesSupported ? attached.handlers.onDragOver : undefined}
      onDrop={imagesSupported ? attached.handlers.onDrop : undefined}
    >
      {imagesSupported && <ChatImageStrip images={attached.images} uploading={attached.uploading} onRemove={attached.remove} />}
      <textarea
        className="chat-input"
        rows={3}
        value={text}
        aria-label="给 agent 的消息"
        readOnly={starting}
        placeholder={
          surface.sendBlocker ?? (idle || stopped ? '给 agent 发消息，Enter 发送，Shift+Enter 换行'
            : queueable ? `${turn === 'awaiting' ? '先回答上面的请求，' : ''}也可以写下一条，Enter 排到回合结束后发送；Esc 中断`
            : turn === 'awaiting' ? '先回答上面的请求' : 'agent 正在处理，可以先写下一条；Esc 中断')
        }
        onChange={(event) => setText(event.target.value)}
        onPaste={imagesSupported ? attached.handlers.onPaste : undefined}
        onKeyDown={(event) => {
          if (sendsMessage(event)) {
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
    {(imagesSupported || (optionsSupported && state)) && (
      <div className="chat-options">
        {imagesSupported && <ChatAddMenu disabled={starting} onAdd={attached.add} />}
        {optionsSupported && state && <ChatOptionsBar conversation={conversation} state={state} />}
      </div>
    )}
    </>
  )
}
