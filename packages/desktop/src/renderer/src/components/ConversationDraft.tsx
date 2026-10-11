import { useEffect, useMemo, useState } from 'react'
import { ChatPermissionMode, type AgentKind, type ChatCatalog } from '@kando/protocol'
import { closeConversationDraft, perform, selectConversation, useChatImagesSupported, useChatOptionsSupported, useConversationWorktreesSupported, useCore, useStartBranchSupported } from '../core-store'
import { defaultAgent } from '../default-agent'
import { currentInstalledAgents, useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { kandoEntries } from '../chat-commands'
import { AgentQuotaHint, confirmQuota, modelText } from './AgentQuota'
import { usePreferences } from '../preferences'
import { startOptions } from './ConversationActions'
import { sendsMessage } from './ChatComposer'
import { ChatAddMenu, ChatImageStrip, useComposerImages } from './ChatImages'
import { useChatCommandMenu } from './ChatCommandMenu'
import { useChatMentionMenu } from './ChatMentionMenu'
import { MentionField, useMentionedText } from './ChatMentionField'
import { writeMentions } from '../chat-mentions'
import { defaultStartMode, DEFAULT_START_MODES, effortLabel, modeOptions, modeTone, startModes } from './ChatOptionsBar'
import { ChatModelPicker, ChatPicker } from './ChatPicker'
import { AgentIcon, CloseIcon, EnterIcon } from './icons'
import { ProjectPicker } from './ProjectPicker'
import { DraftBranchPicker, useProjectBranches } from './DraftBranchPicker'
import { composerDraft, EMPTY_DRAFT, saveComposerDraft } from '../composer-drafts'
import { keepInitialMessage, sendInitialMessage } from '../initial-messages'

// A new conversation while chats are the default: the agent and projects are picked on the page,
// and the first message creates the conversation and starts the agent, so none is left empty.
export function ConversationDraft() {
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const installed = useInstalledAgents()
  // The agent the latest conversation ended with, if it is here, else a new task's default; unset
  // when that leaves it for each start to pick.
  const [agent, setAgent] = useState<AgentKind | null>(() => {
    const latest = Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.agent
    return latest && currentInstalledAgents().includes(latest) ? latest : defaultAgent(tasks)
  })
  const [projectPaths, setProjectPaths] = useState<string[]>([])
  const [worktree, setWorktree] = useState(false)
  const [draft] = useState(() => composerDraft(null))
  const { value, setText, setValue } = useMentionedText({ text: draft.text, mentions: draft.mentions })
  const { text } = value
  const [busy, setBusy] = useState(false)
  // Kept per agent, so switching back finds the mode picked for it.
  const [modes, setModes] = useState<Record<AgentKind, ChatPermissionMode>>(DEFAULT_START_MODES)
  // A model or effort left unpicked is the agent's own default, which the start does not pass.
  const [picks, setPicks] = useState<Record<AgentKind, { model?: string; effort?: string }>>({ claude: {}, codex: {}, cursor: {} })
  // Each agent's models, asked for once it is picked; absent while asking, null when core cannot say.
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentKind, ChatCatalog | null>>>({})
  const rpc = useCore((s) => s.rpc)
  const deferStart = rpc?.features.includes('deferred-conversation-start') ?? false
  const optionsSupported = useChatOptionsSupported()
  const imagesSupported = useChatImagesSupported()
  const worktreesSupported = useConversationWorktreesSupported()
  const inWorktree = worktree && worktreesSupported && projectPaths.length > 0
  // The primary project's branch: where its worktree starts, or what it is switched to; null keeps
  // the one checked out. Picked again for each primary.
  const startBranchSupported = useStartBranchSupported()
  const primary = startBranchSupported ? (projectPaths[0] ?? null) : null
  const branches = useProjectBranches(primary)
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => setBranch(null), [primary])
  const startBranch = branches.options?.git ? branch : null
  const attached = useComposerImages(draft.images)
  useEffect(() => saveComposerDraft(null, { ...value, images: attached.images }), [value, attached.images])
  const allowBypass = usePreferences((s) => s.allowBypass)
  const width = usePreferences((s) => s.chatWidth)
  const fontSize = usePreferences((s) => s.chatFontSize)
  const font = usePreferences((s) => s.chatFont)
  const canSend = agent !== null && !busy && attached.uploading === 0 && (text.trim() !== '' || attached.images.length > 0)
  // Only the user's own commands: the agent has not started to say what it takes.
  const chatCommands = useCore((s) => s.chatCommands)
  const commandEntries = useMemo(() => kandoEntries(chatCommands, projectPaths), [chatCommands, projectPaths])
  const commandMenu = useChatCommandMenu({ text, entries: commandEntries, agentLabel: agent ? AGENT_LABEL[agent] : '', setText, sendCommand: () => {} })
  // The agent will work in the first project picked.
  const mentionMenu = useChatMentionMenu({ value, setText, setValue, roots: projectPaths, cwd: projectPaths[0] ?? null, agent })
  // Written out for the agent picked when it goes, which may not be the one picked before.
  const written = agent ? writeMentions(value, agent) : text

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
  const model = catalog?.models.find((each) => each.id === modelId)
  const efforts = model?.efforts ?? []
  // A mode the model or settings no longer allow falls back to that agent's available default.
  const offeredModes = agent ? startModes(agent, model, allowBypass) : []
  const mode = agent ? (offeredModes.includes(modes[agent]) ? modes[agent] : defaultStartMode(agent, offeredModes)) : null
  const effort = pick.effort && efforts.includes(pick.effort) ? pick.effort : null
  // The model a start would run, as quota windows name models; unknown until its catalog is in.
  const modelFor = (kind: AgentKind) => {
    const models = catalogs[kind]?.models ?? []
    const id = picks[kind].model ?? models.find((each) => each.isDefault)?.id
    return modelText(models.find((each) => each.id === id))
  }
  const choose = (next: { model?: string; effort?: string }) => {
    if (agent) setPicks({ ...picks, [agent]: next })
  }

  // The page is how a chat start begins, as settings choose; a terminal start has its dialog.
  const create = () => {
    if (!agent || !confirmQuota(agent, modelFor(agent))) return Promise.resolve(null)
    const chosen = optionsSupported
      ? { permissionMode: mode ?? undefined, ...(pick.model ? { model: pick.model } : {}), ...(effort ? { effort } : {}) }
      : {}
    return perform((rpc) => rpc.call('conversations.create', { agent, projectPaths, ...(deferStart ? { deferStart: true } : {}), ...(inWorktree ? { worktree: true } : {}), ...(startBranch ? { branch: startBranch } : {}), ...startOptions(), ...chosen }))
  }
  // Open before launching; the first message keeps its own delivery and retry state.
  const send = async () => {
    const expanded = commandMenu.expand(written)
    if (expanded !== null) {
      setText(expanded)
      return
    }
    if (!canSend) return
    setBusy(true)
    const created = await create()
    if (created) {
      if (deferStart && rpc) {
        keepInitialMessage(created.id, written.trim(), attached.images)
        saveComposerDraft(null, EMPTY_DRAFT)
        useCore.setState((state) => ({ conversations: { ...state.conversations, [created.id]: created } }))
        selectConversation(created.id)
        void sendInitialMessage(created.id, rpc)
        return
      }
      const images = attached.images.map((image) => image.id)
      const sent = await perform((rpc) => rpc.call('conversations.send', { id: created.id, text: written.trim(), ...(images.length ? { images } : {}) }))
      if (sent) saveComposerDraft(null, EMPTY_DRAFT)
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
        <div className="chat-view" data-width={width} data-font-size={fontSize} data-font={font}>
          <div className="chat-list chat-draft">
            <div className="chat-draft-start">
              <h2 className="chat-draft-title">用哪个 Agent 开始</h2>
              <div className="chat-draft-agents" role="radiogroup" aria-label="agent">
                {installed.map((kind) => (
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
                    <AgentQuotaHint agent={kind} model={modelFor(kind)} />
                  </button>
                ))}
              </div>
              <p className="chat-draft-hint muted">发出第一条消息时创建会话并启动 Agent。</p>
            </div>
          </div>
          <div className="chat-dock">
            <div className="chat-dock-header chat-draft-projects">
              <ProjectPicker projects={projectPaths.map((path) => ({ path, worktreePath: null }))} onChange={setProjectPaths} locked={busy} />
              {branches.options?.git && (
                <DraftBranchPicker
                  options={branches.options}
                  picked={branch}
                  worktree={inWorktree}
                  locked={busy}
                  onOpen={branches.refresh}
                  onPick={setBranch}
                />
              )}
              {projectPaths.length > 0 && worktreesSupported && (
                <label
                  className="chat-draft-worktree"
                  data-tooltip-side="top"
                  data-tooltip={startBranchSupported
                    ? '主项目从左边选的分支、其他项目从当前提交，各拉一个新分支和 worktree，互不干扰；未提交的改动不会带过去。不勾选就直接在项目目录里改'
                    : '每个项目从当前提交拉一个新分支和 worktree，互不干扰；未提交的改动不会带过去。不勾选就直接在项目目录里改'}
                >
                  <input type="checkbox" checked={worktree} disabled={busy} onChange={(event) => setWorktree(event.target.checked)} />
                  新 worktree
                </label>
              )}
            </div>
            <div
              className="chat-input-card"
              data-working={busy || undefined}
              onDragOver={imagesSupported ? attached.handlers.onDragOver : undefined}
              onDrop={imagesSupported ? attached.handlers.onDrop : undefined}
            >
              {commandMenu.menu}
              {mentionMenu.menu}
              {imagesSupported && <ChatImageStrip images={attached.images} uploading={attached.uploading} onRemove={attached.remove} />}
              <MentionField value={value} input={mentionMenu.inputProps.ref}>
                <textarea
                  className="chat-input"
                  rows={3}
                  value={text}
                  {...commandMenu.inputProps}
                  {...mentionMenu.inputProps}
                  autoFocus
                  readOnly={busy}
                  aria-label="第一条消息"
                  placeholder={agent ? `给 ${AGENT_LABEL[agent]} 发第一条消息，Enter 发送，Shift+Enter 换行` : '先在上面选一个 Agent'}
                  onChange={(event) => setText(event.target.value, event.target.selectionEnd)}
                  onPaste={imagesSupported ? attached.handlers.onPaste : undefined}
                  onKeyDown={(event) => {
                    if (commandMenu.onKeyDown(event) || mentionMenu.onKeyDown(event) || !sendsMessage(event)) return
                    event.preventDefault()
                    void send()
                  }}
                />
              </MentionField>
              <div className="chat-options">
                {imagesSupported && <ChatAddMenu disabled={busy} onAdd={attached.add} />}
                {agent && optionsSupported && (
                  <>
                    <ChatPicker
                      label="权限模式"
                      value={mode}
                      placeholder="权限模式"
                      options={modeOptions(agent, offeredModes)}
                      tone={modeTone(mode)}
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
                        models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
                        model={modelId}
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
                  data-tooltip={busy && agent ? (inWorktree ? `正在建 worktree 并启动 ${AGENT_LABEL[agent]}…` : `正在启动 ${AGENT_LABEL[agent]}…`) : '发送（Enter）'}
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
