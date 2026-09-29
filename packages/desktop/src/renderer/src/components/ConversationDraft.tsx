import { useEffect, useState } from 'react'
import { AGENT_KINDS, ChatPermissionMode, type AgentKind, type ChatCatalog } from '@kando/protocol'
import { closeConversationDraft, perform, selectConversation, useChatImagesSupported, useChatOptionsSupported, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { AGENT_LABEL } from '../labels'
import { usePreferences } from '../preferences'
import { startOptions } from './ConversationActions'
import { sendsMessage } from './ChatComposer'
import { ChatAddMenu, ChatImageStrip, useComposerImages } from './ChatImages'
import { effortLabel, modeOptions, modeTone, START_MODES } from './ChatOptionsBar'
import { ChatModelPicker, ChatPicker } from './ChatPicker'
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
  // Kept per agent, so switching back finds the mode picked for it.
  const [modes, setModes] = useState<Record<AgentKind, ChatPermissionMode>>({ claude: START_MODES.claude[0]!, codex: START_MODES.codex[0]! })
  // A model or effort left unpicked is the agent's own default, which the start does not pass.
  const [picks, setPicks] = useState<Record<AgentKind, { model?: string; effort?: string }>>({ claude: {}, codex: {} })
  // Each agent's models, asked for once it is picked; absent while asking, null when core cannot say.
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentKind, ChatCatalog | null>>>({})
  const rpc = useCore((s) => s.rpc)
  const optionsSupported = useChatOptionsSupported()
  const imagesSupported = useChatImagesSupported()
  const attached = useComposerImages()
  const allowBypass = usePreferences((s) => s.allowBypass)
  const width = usePreferences((s) => s.chatWidth)
  const canSend = agent !== null && !busy && attached.uploading === 0 && (text.trim() !== '' || attached.images.length > 0)

  useEffect(() => {
    if (!agent || !rpc || !optionsSupported || agent in catalogs) return
    let current = true
    const settle = (catalog: ChatCatalog | null) => current && setCatalogs((known) => ({ ...known, [agent]: catalog }))
    // Not through perform: an older core without the method just offers no models.
    rpc.call('conversations.chatCatalog', { agent }).then(settle, () => settle(null))
    return () => { current = false }
  }, [agent, rpc, optionsSupported, catalogs])

  const catalog = agent ? catalogs[agent] : null
  const pick = agent ? picks[agent] : {}
  const modelId = pick.model ?? catalog?.models.find((each) => each.isDefault)?.id ?? null
  const efforts = catalog?.models.find((each) => each.id === modelId)?.efforts ?? []
  const effort = pick.effort && efforts.includes(pick.effort) ? pick.effort : null
  const choose = (next: { model?: string; effort?: string }) => {
    if (agent) setPicks({ ...picks, [agent]: next })
  }

  // The page is how a chat start begins, as settings choose; a terminal start has its dialog.
  const create = () => {
    if (!agent) return Promise.resolve(null)
    const chosen = optionsSupported
      ? { permissionMode: modes[agent], ...(pick.model ? { model: pick.model } : {}), ...(effort ? { effort } : {}) }
      : {}
    return perform((rpc) => rpc.call('conversations.create', { agent, projectPaths, ...startOptions('chat'), ...chosen }))
  }
  // Created once the agent is ready, then sent before the page gives way to the conversation, so
  // a start that fails leaves the message here to try again.
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    const created = await create()
    if (created) {
      const images = attached.images.map((image) => image.id)
      await perform((rpc) => rpc.call('conversations.send', { id: created.id, text: text.trim(), ...(images.length ? { images } : {}) }))
      selectConversation(created.id)
      return
    }
    setBusy(false)
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
        <div className="chat-view" data-width={width}>
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
              <p className="chat-draft-hint muted">发出第一条消息时创建会话并启动 agent。</p>
            </div>
          </div>
          <div className="chat-dock">
            <div className="chat-dock-header chat-draft-projects">
              <ProjectPicker projects={projectPaths.map((path) => ({ path, worktreePath: null }))} onChange={setProjectPaths} locked={busy} />
              <span className="muted">{projectPaths.length === 0 ? '不选项目时，用 Kando 的工作目录' : '高亮的主项目是默认工作目录，其他项目也可访问；直接使用所选目录。'}</span>
            </div>
            <div
              className="chat-input-card"
              data-working={busy || undefined}
              onDragOver={imagesSupported ? attached.handlers.onDragOver : undefined}
              onDrop={imagesSupported ? attached.handlers.onDrop : undefined}
            >
              {imagesSupported && <ChatImageStrip images={attached.images} uploading={attached.uploading} onRemove={attached.remove} />}
              <textarea
                className="chat-input"
                rows={3}
                value={text}
                autoFocus
                readOnly={busy}
                aria-label="第一条消息"
                placeholder={agent ? `给 ${AGENT_LABEL[agent]} 发第一条消息，Enter 发送，Shift+Enter 换行` : '先在上面选一个 agent'}
                onChange={(event) => setText(event.target.value)}
                onPaste={imagesSupported ? attached.handlers.onPaste : undefined}
                onKeyDown={(event) => {
                  if (!sendsMessage(event)) return
                  event.preventDefault()
                  void send()
                }}
              />
              <div className="chat-options">
                {imagesSupported && <ChatAddMenu disabled={busy} onAdd={attached.add} />}
                {agent && optionsSupported && (
                  <>
                    <ChatPicker
                      label="权限模式"
                      value={modes[agent]}
                      placeholder="权限模式"
                      options={modeOptions(agent, [...START_MODES[agent], ...(allowBypass ? ['bypass' as const] : [])])}
                      tone={modeTone(modes[agent])}
                      disabled={busy}
                      onChange={(value) => {
                        const picked = ChatPermissionMode.safeParse(value)
                        if (picked.success) setModes({ ...modes, [agent]: picked.data })
                      }}
                    />
                    <span className="chat-dock-spacer" />
                    {catalog === undefined && <span className="chat-options-note muted">正在读取模型…</span>}
                    {catalog && (
                      <ChatModelPicker
                        models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description }))}
                        model={modelId}
                        efforts={efforts.map((each) => ({ value: each, label: effortLabel(each) }))}
                        effort={effort}
                        disabled={busy}
                        onModel={(value) => {
                          const next = catalog.models.find((each) => each.id === value)
                          // An effort the new model does not take goes with the old one.
                          if (next) choose({ model: next.id, effort: pick.effort && next.efforts.includes(pick.effort) ? pick.effort : undefined })
                        }}
                        onEffort={(value) => choose({ ...pick, effort: value })}
                      />
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="chat-input-button" data-tooltip-side="top-end"
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
      </div>
    </section>
  )
}
