import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import type { ChatImage, ChatItem, ChatQueued, Conversation } from '@kando/protocol'
import { perform, useChatImagesSupported, useChatOptionsSupported, useCore, useFileMentionsSupported, useSchedulesSupported } from '../core-store'
import { agentEntries, kandoEntries } from '../chat-commands'
import { composeMessage, parseQuotes, setQuotes, useQuotes } from '../chat-quotes'
import { QuoteCards } from './ChatQuoteCards'
import { AGENT_LABEL } from '../labels'
import { useChatSurface } from './chat-surface'
import { ChatAddMenu, ChatImageStrip, useComposerImages } from './ChatImages'
import { useChatCommandMenu } from './ChatCommandMenu'
import { useChatMentionMenu } from './ChatMentionMenu'
import { ChatOptionsBar } from './ChatOptionsBar'
import { ChevronDownIcon, ClockIcon, CloseIcon, EnterIcon, PencilIcon, StopIcon } from './icons'
import { SchedulePicker } from './SchedulePicker'
import { createSchedule } from '../schedules'

// Enter sends and Shift+Enter breaks the line; Enter while an input method is composing picks a
// candidate instead.
export function sendsMessage(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

// ⌘Enter (Ctrl+Enter elsewhere) sends into the running turn instead of queueing.
export function steersMessage(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing
}

// Tab or →, alone, takes the suggestion the empty input shows.
function takesSuggestion(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const alone = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing
  return alone && (event.key === 'Tab' || event.key === 'ArrowRight')
}

// Images from two sources in order, each once.
export function mergeImages(first: readonly ChatImage[], second: readonly ChatImage[]): ChatImage[] {
  const known = new Set(first.map((image) => image.id))
  return [...first, ...second.filter((image) => !known.has(image.id))]
}

type StateItem = Extract<ChatItem, { kind: 'state' }>

// A waiting message as its row reads it: what the user wrote, and how many passages it quotes.
function queuedText(text: string): string {
  const { quotes, body } = parseQuotes(text)
  const quoted = quotes.length ? `（引用 ${quotes.length} 段）` : ''
  return `${quoted}${body}` || '（只有图片）'
}

// Sends what the input holds later, unattended: once its time comes and the agent has quota again.
// An empty input schedules carrying out the plan the chat has.
function ScheduleSendButton({ conversationId, text, disabledReason, onScheduled }: {
  conversationId: string
  text: string
  disabledReason: string | null
  onScheduled: () => void
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor chat-schedule-anchor">
      <button
        type="button"
        className="tool-button chat-schedule-button"
        aria-label="预约发送"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabledReason !== null}
        data-tooltip={disabledReason ?? (text ? '预约发送：额度恢复后或到点再发' : '预约：额度恢复后或到点按计划开始实现')}
        data-tooltip-side="top-end"
        onClick={() => setOpen(!open)}
      >
        <ClockIcon />
      </button>
      {open && (
        <SchedulePicker
          title={text ? '预约发送这条消息' : '预约按计划开始实现'}
          note={text ? '到点后发出这条消息，agent 不会停下来等你确认。' : '到点后让 agent 按定下的计划开始实现。'}
          onSchedule={async (notBefore) => {
            const run = await createSchedule({ kind: 'conversation', conversationId, text: text.trim() }, notBefore)
            if (run) onScheduled()
            return run !== null
          }}
          onClose={close}
        />
      )}
    </span>
  )
}

// The messages waiting above the input, in the order they will go: one per turn as each ends. A
// failed turn holds them; the first is released from the header, any of them from its row. Each
// can be edited back into the input, dropped, or, where the agent takes it, put into the running
// turn at once.
function QueuedRow({ entry, index, steerable, onEdit, onRelease, onNow, onCancel }: {
  entry: ChatQueued
  index: number
  steerable: boolean
  onEdit: (entry: ChatQueued) => void
  onRelease: (ref: string) => void
  onNow: (ref: string) => void
  onCancel: (ref: string) => void
}) {
  return (
    <>
      {index >= 0 && <span className="chat-queued-index">{index + 1}.</span>}
      <span className="chat-queued-text" title={entry.text}>{queuedText(entry.text)}</span>
      {entry.images.length > 0 && <span className="chat-queued-images">{entry.images.length} 张图片</span>}
      <span className="chat-queued-actions">
        {entry.held && index > 0 && (
          <button type="button" className="chat-queued-action" aria-label="发送这条" data-tooltip="发送这条" data-tooltip-side="top-end" onClick={() => onRelease(entry.ref)}><EnterIcon /></button>
        )}
        {steerable && (
          <button type="button" className="chat-queued-action" aria-label="立刻插入到进行中的回合" data-tooltip="立刻插入" data-tooltip-side="top-end" onClick={() => onNow(entry.ref)}><EnterIcon /></button>
        )}
        <button type="button" className="chat-queued-action" aria-label="编辑，放回输入框" data-tooltip="编辑" data-tooltip-side="top-end" onClick={() => onEdit(entry)}><PencilIcon /></button>
        <button type="button" className="chat-queued-action" aria-label="删除" data-tooltip="删除" data-tooltip-side="top-end" onClick={() => onCancel(entry.ref)}><CloseIcon /></button>
      </span>
    </>
  )
}

// The messages waiting to go, at the top of the dock. One shows as it is; several fold to a line
// saying how many and which goes next, opening on a click. A failed turn holds them; the first is
// released from the header, any other from its row. Each can be edited back into the input,
// dropped, or, where the agent takes it, put into the running turn at once.
function QueuedList({ queue, held, steerable, ...actions }: {
  queue: readonly ChatQueued[]
  held: boolean
  steerable: boolean
  onEdit: (entry: ChatQueued) => void
  onRelease: (ref: string) => void
  onNow: (ref: string) => void
  onCancel: (ref: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [first] = queue
  if (first && queue.length === 1) {
    return (
      <div className="chat-queue chat-queue-one chat-queued" data-held={held || undefined}>
        <span className="chat-queue-label">{held ? '上一回合没有完成，还没发：' : '回合结束后发送：'}</span>
        <QueuedRow entry={first} index={-1} steerable={steerable} {...actions} />
      </div>
    )
  }
  return (
    <div className="chat-queue" data-held={held || undefined}>
      <div className="chat-queue-head">
        <button type="button" className="chat-queue-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chat-queue-label">{held ? `${queue.length} 条没发出` : `${queue.length} 条排队`}</span>
          {!open && first && <span className="chat-queue-next">下一条：<span>{queuedText(first.text)}</span></span>}
          <span className="chat-tool-chevron" aria-hidden="true"><ChevronDownIcon /></span>
        </button>
        {held && first && <button type="button" className="link-button" onClick={() => actions.onRelease(first.ref)}>继续发送第 1 条</button>}
      </div>
      {open && (
        <ol className="chat-queue-list">
          {queue.map((entry, index) => (
            <li key={entry.ref} className="chat-queued" data-held={entry.held || undefined}>
              <QueuedRow entry={entry} index={index} steerable={steerable} {...actions} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// Enter sends when the agent is idle; while it works, Enter queues the message behind any already
// waiting, and ⌘Enter puts it into the running turn where the agent takes that. With no agent
// running, it starts one on the same session first. The corner button sends, or stops the turn.
// Images pasted, dropped or picked from the ＋ below sit above the text until it goes. `state` is
// the running stage's, for the options row.
export function ChatComposer({ conversation, state }: { conversation: Conversation; state: StateItem | null }) {
  const { id } = conversation
  const surface = useChatSurface()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const quotes = useQuotes(id)
  const imagesSupported = useChatImagesSupported()
  const optionsSupported = useChatOptionsSupported()
  const schedulesSupported = useSchedulesSupported()
  const mentionsSupported = useFileMentionsSupported()
  const attached = useComposerImages()
  const running = conversation.sessionId !== null
  // An older core reports only the first waiting message, without a ref to act on it by.
  const queue: readonly ChatQueued[] = !running || !state ? []
    : state.queue.length > 0 ? state.queue
      : state.queued ? [{ ref: '', text: state.queued.text, held: state.queued.held, images: state.queued.images }] : []
  const steerable = Boolean(state?.steerable)
  const turn = conversation.chat?.turn ?? null
  const idle = running && turn === 'idle'
  const working = running && (turn === 'running' || turn === 'awaiting')
  // An older core takes a message only between turns.
  const queueable = optionsSupported && working
  const stopped = !running
  const starting = stopped && busy
  const canTake = (idle || queueable || stopped) && !busy && !surface.sendBlocker && attached.uploading === 0
  const canSend = canTake && (text.trim() !== '' || attached.images.length > 0 || quotes.length > 0)
  // What the agent guesses comes next, as Claude Code shows it: grey in the empty input, Tab or →
  // takes it, typing anything else puts it away for good.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const offered = idle ? conversation.chat?.suggestion ?? null : null
  const suggestion = offered && offered !== dismissed && text === '' && attached.images.length === 0 && quotes.length === 0 && !surface.sendBlocker ? offered : null
  const canSteer = queueable && steerable && canSend
  const chatCommands = useCore((s) => s.chatCommands)
  const commandEntries = useMemo(
    () => [...kandoEntries(chatCommands, conversation.projectPaths), ...agentEntries(state?.commands ?? [])],
    [chatCommands, conversation.projectPaths, state?.commands]
  )
  const commandMenu = useChatCommandMenu({
    text,
    entries: commandEntries,
    agentLabel: AGENT_LABEL[conversation.agent],
    setText,
    sendCommand: (command) => void send(false, command)
  })
  const mentionMenu = useChatMentionMenu({ text, setText, roots: conversation.projectPaths, cwd: conversation.workspacePath, agent: conversation.agent })
  // steer: into the running turn now; otherwise a message while the agent works waits its turn.
  // The user's own command expands into the input to be read over, rather than going.
  const send = async (steer = false, message = text) => {
    const expanded = commandMenu.expand(message)
    if (expanded !== null) {
      setText(expanded)
      return
    }
    // Quotes go before what the user wrote; a command must open its message, so it goes alone.
    const quoting = quotes.length > 0 && !message.trim().startsWith('/')
    const composed = quoting ? composeMessage(quotes, message) : message.trim()
    if (!canTake || (composed === '' && attached.images.length === 0) || (steer && !canSteer)) return
    setBusy(true)
    const images = attached.images
    // Getting ready resolves once the agent can take it; if that fails, the text stays to try again.
    const ready = await surface.prepareSend(stopped)
    const sent = ready && await perform((rpc) => rpc.call('conversations.send', {
      id,
      text: composed,
      ...(images.length ? { images: images.map((image) => image.id) } : {}),
      ...(queueable ? (steer ? { steer: true } : { queue: true }) : {})
    }))
    setBusy(false)
    if (sent) {
      setText('')
      attached.setImages([])
      if (quoting) setQuotes(id, [])
    }
  }
  const cancelQueued = (ref: string) => perform((rpc) => rpc.call('conversations.cancelQueued', { id, ...(ref ? { ref } : {}) }))
  const releaseQueued = (ref: string) => void perform((rpc) => rpc.call('conversations.sendQueued', { id, ...(ref ? { ref } : {}) }))
  const sendQueuedNow = (ref: string) => void perform((rpc) => rpc.call('conversations.sendQueued', { id, ...(ref ? { ref } : {}), now: true }))
  const editQueued = async (entry: ChatQueued) => {
    if (await cancelQueued(entry.ref)) {
      const parsed = parseQuotes(entry.text)
      if (parsed.quotes.length) setQuotes(id, [...parsed.quotes, ...quotes])
      setText((current) => [parsed.body, current].filter((part) => part.trim()).join('\n\n'))
      attached.setImages((current) => mergeImages(entry.images, current))
    }
  }
  const interrupt = () => void perform((rpc) => rpc.call('conversations.interrupt', { id }))
  return (
    <>
    {queue.length > 0 && (
      <QueuedList
        queue={queue}
        held={queue.some((entry) => entry.held)}
        steerable={steerable && working}
        onEdit={(entry) => void editQueued(entry)}
        onRelease={releaseQueued}
        onNow={sendQueuedNow}
        onCancel={(ref) => void cancelQueued(ref)}
      />
    )}
    <div
      className="chat-input-card"
      data-working={working || starting || undefined}
      data-awaiting={turn === 'awaiting' || undefined}
      onDragOver={imagesSupported ? attached.handlers.onDragOver : undefined}
      onDrop={imagesSupported ? attached.handlers.onDrop : undefined}
    >
      {commandMenu.menu}
      {mentionMenu.menu}
      {quotes.length > 0 && <QuoteCards conversationId={id} quotes={quotes} onDone={() => mentionMenu.inputProps.ref.current?.focus()} />}
      {imagesSupported && <ChatImageStrip images={attached.images} uploading={attached.uploading} onRemove={attached.remove} />}
      <textarea
        className="chat-input"
        rows={3}
        value={text}
        aria-label="给 agent 的消息"
        {...commandMenu.inputProps}
        {...mentionMenu.inputProps}
        readOnly={starting}
        placeholder={
          surface.sendBlocker ?? suggestion ?? (idle || stopped ? `给 agent 发消息，Enter 发送，Shift+Enter 换行${commandEntries.length > 0 ? '，/ 选命令' : ''}${mentionsSupported ? '，@ 引用文件' : ''}`
            : queueable ? `${turn === 'awaiting' ? '先回答上面的请求，' : ''}也可以写下一条，Enter 排到回合结束后发送${steerable ? '，⌘Enter 立刻插入' : ''}；Esc 中断`
            : turn === 'awaiting' ? '先回答上面的请求' : 'agent 正在处理，可以先写下一条；Esc 中断')
        }
        onChange={(event) => {
          if (suggestion && event.target.value) setDismissed(suggestion)
          setText(event.target.value)
        }}
        onPaste={imagesSupported ? attached.handlers.onPaste : undefined}
        onKeyDown={(event) => {
          if (commandMenu.onKeyDown(event) || mentionMenu.onKeyDown(event)) return
          if (suggestion && takesSuggestion(event)) {
            event.preventDefault()
            setText(suggestion)
          } else if (steersMessage(event)) {
            event.preventDefault()
            void send(true)
          } else if (sendsMessage(event)) {
            event.preventDefault()
            void send()
          } else if (event.key === 'Escape' && working && !event.nativeEvent.isComposing) {
            event.preventDefault()
            interrupt()
          }
        }}
      />
      {/* Under the input, inside its box: what goes with the message, how the agent runs, and send. */}
      <div className="chat-options">
        {imagesSupported && <ChatAddMenu disabled={starting} onAdd={attached.add} />}
        {optionsSupported && state && <ChatOptionsBar conversation={conversation} state={state} />}
        {suggestion && (
          <span className="chat-suggestion-hint" aria-hidden="true">
            <kbd>Tab</kbd> 填入建议
          </span>
        )}
        {schedulesSupported && (
          <ScheduleSendButton
            conversationId={id}
            text={composeMessage(quotes, text)}
            disabledReason={attached.images.length > 0 ? '预约的消息不能带图片' : surface.sendBlocker ?? null}
            onScheduled={() => {
              setText('')
              setQuotes(id, [])
            }}
          />
        )}
        {canSteer && (
          <button type="button" className="button ghost chat-steer-button" data-tooltip-side="top-end" data-tooltip="不等回合结束，现在就交给 agent（⌘Enter）" onClick={() => void send(true)}>
            立刻插入
          </button>
        )}
        {working ? (
          <button type="button" className="chat-input-button" data-tooltip-side="top-end" data-stop aria-label="中断这一回合（Esc）" data-tooltip="中断（Esc）" onClick={interrupt}>
            <StopIcon />
          </button>
        ) : (
          <button type="button" className="chat-input-button" data-tooltip-side="top-end" aria-label="发送（Enter）" data-tooltip={starting ? `正在启动 ${AGENT_LABEL[conversation.agent]}…` : '发送（Enter）'} disabled={!canSend} onClick={() => void send()}>
            <EnterIcon />
          </button>
        )}
      </div>
    </div>
    </>
  )
}
