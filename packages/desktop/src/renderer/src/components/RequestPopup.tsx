import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ChatItem, Conversation } from '@kando/protocol'
import { dropChat, pathShortener, setChatPage, useChat } from '../chat-state'
import { dismissError, perform, useCore } from '../core-store'
import { layoutRequestPopup, onRequestPopupWanted, openFromRequestPopup } from '../desktop-bridge'
import { AGENT_LABEL } from '../labels'
import { usePreferences } from '../preferences'
import { popupKey, popupLabel, popupQueue, type PopupEntry } from '../request-popup'
import { ChatSurfaceContext, type ChatSurface } from './chat-surface'
import { PendingRequests } from './ChatDock'
import { ChatRoots } from './ChatMarkdown'
import type { RequestItem } from './ChatRequestCards'
import { ChatPaths } from './ChatToolCard'
import { scheduleErrorToastDismiss } from './ErrorToast'
import { ChevronRightIcon, CloseIcon } from './icons'

type StateItem = Extract<ChatItem, { kind: 'state' }>

const NO_ITEMS: readonly ChatItem[] = []
const NONE_CLOSED: ReadonlySet<string> = new Set()
// Asked for, with nothing to show by then (answered in the meantime): the card stays down.
const GIVE_UP_MS = 5000

// Whether the main window wants the card up. Followed from the page's start: main says so as soon
// as the page loads, which may be before React has mounted anything to hear it.
const useWanted = create<boolean>()(() => false)
const setWanted = (wanted: boolean) => useWanted.setState(wanted, true)

export function followRequestPopupWanted(): void {
  onRequestPopupWanted(setWanted)
}

// The card's chat does what the card cannot in the main window, where the whole of it is.
function popupSurface(entry: PopupEntry, conversation: Conversation | undefined): ChatSurface {
  const open = () => openFromRequestPopup(entry.target)
  const { target } = entry
  return {
    inspector: target.kind === 'task' ? 'task' : 'conversation',
    showPlan: open,
    showChanges: open,
    showFileChange: open,
    showBrowser: open,
    changes: null,
    changesHint: '',
    prepareSend: async () => false,
    sendBlocker: null,
    // A task that may only plan keeps its plan for later, as its chat does (TaskChat).
    savePlan: target.kind === 'task' && conversation?.planOnly
      ? async (item) => {
          await perform((rpc) => rpc.call('tasks.savePlan', { id: target.id, stageId: item.stageId, requestId: item.requestId }))
        }
      : null,
    planNote: () => null,
    handoff: null,
    fork: null
  }
}

// The chat's items while the card shows it, kept current as the chat view keeps its own.
function useWatchedChat(conversationId: string | null): readonly ChatItem[] {
  const rpc = useCore((s) => s.rpc)
  useEffect(() => {
    if (!rpc || !conversationId) return
    let current = true
    rpc.call('conversations.watchChat', { id: conversationId }).then(
      (result) => current && setChatPage(conversationId, result),
      () => {}
    )
    return () => {
      current = false
      dropChat(conversationId)
      void rpc.call('conversations.unwatchChat', { id: conversationId }).catch(() => {})
    }
  }, [rpc, conversationId])
  return useChat((s) => (conversationId ? s[conversationId]?.items : undefined)) ?? NO_ITEMS
}

// The window at the top of the screen: what agents wait on while the user is in another app, one
// chat at a time, answered with the chat's own cards. It comes up when the main window asks and
// has something to show, and goes when all is answered, the user closes it, or main puts it away.
export function RequestPopup() {
  const wanted = useWanted()
  const [closed, setClosed] = useState(NONE_CLOSED)
  const [picked, setPicked] = useState<string | null>(null)
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const error = useCore((s) => s.error)
  const fontSize = usePreferences((s) => s.chatFontSize)
  const queue = useMemo(() => popupQueue({ tasks, conversations }, closed), [tasks, conversations, closed])
  const at = Math.max(0, queue.findIndex((each) => each.conversationId === picked))
  const entry = wanted ? queue[at] : undefined
  const conversation = entry ? conversations[entry.conversationId] : undefined
  const items = useWatchedChat(entry?.conversationId ?? null)
  const pending = useMemo(
    () => items.filter((item): item is RequestItem => (item.kind === 'approval' || item.kind === 'question') && item.resolution === null),
    [items]
  )
  const tools = useMemo(() => new Map(items.flatMap((item) => (item.kind === 'tool' ? [[item.id, item] as const] : []))), [items])
  const state = useMemo(() => items.findLast((item): item is StateItem => item.kind === 'state') ?? null, [items])
  const roots = useMemo(
    () => (conversation ? (conversation.projectPaths.length ? conversation.projectPaths : [conversation.workspacePath]) : []),
    [conversation]
  )
  const shorten = useMemo(() => pathShortener(roots), [roots])
  const surface = useMemo(() => (entry ? popupSurface(entry, conversation) : null), [entry, conversation])

  useEffect(() => (error ? scheduleErrorToastDismiss(dismissError) : undefined), [error])

  // Up once there is something to answer; once up, kept while the next chat's items load, so
  // answering one chat does not flash the window down and up again on its way to the next.
  const frame = useRef<HTMLDivElement>(null)
  const shown = useRef(false)
  const active = entry !== undefined
  const ready = active && pending.length > 0
  useLayoutEffect(() => {
    const node = frame.current
    if (!active || !node || !(ready || shown.current)) {
      if (!active) shown.current = false
      layoutRequestPopup(false, 0)
      return
    }
    shown.current = true
    const report = () => layoutRequestPopup(true, node.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [active, ready])

  // All answered: done until asked again. Asked for but nothing came up in time: the same.
  useEffect(() => {
    if (!wanted || queue.length > 0) return
    const timer = setTimeout(() => setWanted(false), shown.current ? 0 : GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [wanted, queue.length])

  if (!entry || !conversation || !surface) return <div ref={frame} />
  const close = () => {
    setClosed(new Set([...closed, ...queue.map((each) => popupKey(each.conversationId, each.request))]))
    setWanted(false)
  }
  const step = (by: number) => setPicked(queue[(at + by + queue.length) % queue.length]?.conversationId ?? null)
  return (
    <div ref={frame} className="request-popup-frame">
      <section className="chat-view request-popup" data-font-size={fontSize} aria-label="等你处理的请求">
        <header className="request-popup-header">
          <span className="request-popup-label">{popupLabel(entry.request)}</span>
          <span className="request-popup-title" title={entry.title}>{entry.title}</span>
          <span className="request-popup-agent">{AGENT_LABEL[conversation.agent]}</span>
          <span className="request-popup-spacer" />
          {queue.length > 1 && (
            <span className="request-popup-pager">
              <button type="button" className="request-popup-step" data-direction="previous" aria-label="上一个" onClick={() => step(-1)}><ChevronRightIcon /></button>
              <span className="request-popup-count">{at + 1} / {queue.length}</span>
              <button type="button" className="request-popup-step" aria-label="下一个" onClick={() => step(1)}><ChevronRightIcon /></button>
            </span>
          )}
          <button type="button" className="link-button" onClick={() => openFromRequestPopup(entry.target)}>在 Kando 中打开</button>
          <button type="button" className="request-popup-close" aria-label="收起，有新的请求再弹出" title="收起，有新的请求再弹出" onClick={close}><CloseIcon /></button>
        </header>
        {error && <p className="request-popup-error" role="alert">{error}</p>}
        <ChatSurfaceContext.Provider value={surface}>
          <ChatPaths.Provider value={shorten}>
            <ChatRoots.Provider value={roots}>
              {pending.length > 0
                ? <PendingRequests conversation={conversation} pending={pending} tools={tools} modes={state?.permissionModes ?? []} />
                : <p className="request-popup-loading">正在读取…</p>}
            </ChatRoots.Provider>
          </ChatPaths.Provider>
        </ChatSurfaceContext.Provider>
      </section>
    </div>
  )
}
