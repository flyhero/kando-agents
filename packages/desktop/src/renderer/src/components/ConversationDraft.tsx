import { useState } from 'react'
import { AGENT_KINDS, type AgentKind, type ConversationMode } from '@kando/protocol'
import { closeConversationDraft, perform, selectConversation, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { AGENT_LABEL } from '../labels'
import { startOptions } from './ConversationActions'
import { sendsMessage } from './ChatComposer'
import { AgentIcon, CloseIcon, EnterIcon } from './icons'
import { ProjectPicker } from './ProjectPicker'

// A new conversation while chats are the default: the agent and projects are picked on the page,
// and the first message creates the conversation and starts the agent, so none is left empty.
export function ConversationDraft() {
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  // The agent the latest conversation ended with, else a new task's default; unset when that
  // leaves it for each start to pick.
  const [agent, setAgent] = useState<AgentKind | null>(() =>
    Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.agent ?? defaultAgent(tasks))
  const [projectPaths, setProjectPaths] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const canSend = agent !== null && !busy && text.trim() !== ''

  const create = (mode: ConversationMode) =>
    agent ? perform((rpc) => rpc.call('conversations.create', { agent, projectPaths, ...startOptions(mode) })) : Promise.resolve(null)
  // Created once the agent is ready, then sent before the page gives way to the conversation, so
  // a start that fails leaves the message here to try again.
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    const created = await create('chat')
    if (created) {
      await perform((rpc) => rpc.call('conversations.send', { id: created.id, text: text.trim() }))
      selectConversation(created.id)
      return
    }
    setBusy(false)
  }
  const startInTerminal = async () => {
    if (busy || !agent) return
    setBusy(true)
    const created = await create('tui')
    setBusy(false)
    if (created) selectConversation(created.id)
  }

  return (
    <section className="detail terminal-view conversation-view" aria-label="新会话">
      <header className="detail-header conversation-header">
        <span className="terminal-view-title">新会话</span>
        <div className="toolbar">
          <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={closeConversationDraft}><CloseIcon /></button>
        </div>
      </header>
      <div className="terminal-body">
        <div className="chat-view">
          <div className="chat-list chat-draft">
            <div className="chat-draft-start">
              <h2 className="chat-draft-title">用哪个 agent 开始</h2>
              <div className="chat-draft-agents" role="radiogroup" aria-label="agent">
                {AGENT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={agent === kind}
                    className="chat-draft-agent"
                    disabled={busy}
                    onClick={() => setAgent(kind)}
                  >
                    <AgentIcon agent={kind} />
                    <span>{AGENT_LABEL[kind]}</span>
                  </button>
                ))}
              </div>
              <p className="chat-draft-hint muted">
                发出第一条消息时创建会话并启动 agent。
                <button type="button" className="link-button" disabled={busy || !agent} onClick={() => void startInTerminal()}>改用终端界面开始</button>
              </p>
            </div>
          </div>
          <div className="chat-dock">
            <div className="chat-dock-header chat-draft-projects">
              <ProjectPicker projects={projectPaths.map((path) => ({ path, worktreePath: null }))} onChange={setProjectPaths} />
              {projectPaths.length === 0 && <span className="muted">不选项目时，用 Kando 的工作目录</span>}
            </div>
            <div className="chat-input-card" data-working={busy || undefined}>
              <textarea
                className="chat-input"
                rows={3}
                value={text}
                autoFocus
                readOnly={busy}
                aria-label="第一条消息"
                placeholder={agent ? `给 ${AGENT_LABEL[agent]} 发第一条消息，Enter 发送，Shift+Enter 换行` : '先在上面选一个 agent'}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (!sendsMessage(event)) return
                  event.preventDefault()
                  void send()
                }}
              />
              <button
                type="button"
                className="chat-input-button"
                aria-label="发送（Enter）"
                data-tooltip={busy && agent ? `正在启动 ${AGENT_LABEL[agent]}…` : '发送（Enter）'}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <EnterIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
