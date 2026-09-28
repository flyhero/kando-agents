import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MAX_TASK_REPOS, type AgentKind, type ChatItem, type ChatOption, type Conversation, type ConversationMessage, type ConversationMode, type ConversationSearchHit, type ConversationStage, type FileDiff, type FolderChanges, type ProjectHead } from '@kando/protocol'
import type { DaemonEvent, SessionInfo } from '@kando/protocol/node'
import type { ChatAnswer, StageMessage } from './chat-driver'
import { ChatHost, type ChatStage } from './chat-host'
import { ChatLog } from './chat-log'
import type { SessionHost } from './daemon-client'
import { ConversationStore } from './conversation-store'
import { folderChanges, folderDiff, folderHead } from './conversation-changes'
import { chatCommand, conversationCommand, handoffPrompt, handoffPromptPath } from './conversation-command'
import { searchSnippet } from './conversation-search'
import { buildHandoff } from './conversation-handoff'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { TerminalTranscript } from './terminal-transcript'
import { normalizeRepoPath, projectHead } from './workspace'

export type ConversationEvent =
  | { type: 'changed'; conversation: Conversation }
  | { type: 'deleted'; id: string }
  | { type: 'chatItems'; conversationId: string; items: ChatItem[] }
  | { type: 'chatDelta'; conversationId: string; stageId: string; itemId: string; append: string }

// A chat page stops adding older stages once it holds this many items.
const CHAT_PAGE_ITEMS = 1000
const STOP_GRACE_MS = 5000
const KILL_GRACE_MS = 2000
// A chat agent left this long with nothing to do is let go (see releaseIdle).
const CHAT_IDLE_MS = 30 * 60_000

// Whether `promise` settles within `ms`.
function settles(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref()
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export class ConversationService {
  private readonly launching = new Set<string>()
  private readonly transcript: TerminalTranscript
  private readonly chats: ChatHost
  // Sessions being stopped on purpose: their exit reads as a stop, not a crash.
  private readonly stopping = new Set<string>()
  private readonly exitWaiters = new Map<string, () => void>()

  constructor(
    private readonly store: ConversationStore,
    private readonly daemon: SessionHost,
    private readonly sessionsRoot: string,
    private readonly callbackCommand: (conversationId: string, stageId: string, agent: AgentKind) => string[],
    private readonly emit: (event: ConversationEvent) => void,
    private readonly projects: ProjectRegistry
  ) {
    this.transcript = new TerminalTranscript(sessionsRoot)
    this.chats = new ChatHost(daemon, sessionsRoot, {
      items: (conversationId, items) => {
        this.rememberMode(conversationId, items)
        this.emit({ type: 'chatItems', conversationId, items })
      },
      delta: (conversationId, stageId, itemId, append) => this.emit({ type: 'chatDelta', conversationId, stageId, itemId, append }),
      messages: (stage, messages) => messages.forEach((message) => this.recordChatMessage(stage, message)),
      provider: (stage, providerSessionId) => this.store.setProviderSession(stage.stageId, providerSessionId),
      activity: (conversationId) => {
        const current = this.store.get(conversationId)
        if (current) this.changed(current)
      },
      offset: (stageId, end) => this.store.setChatOffset(stageId, end)
    })
  }

  list(): Conversation[] { return this.store.list().map((conversation) => this.withChat(conversation)) }
  get(id: string): Conversation {
    const found = this.store.get(id)
    if (!found) throw new Rejection('conversation-not-found', `no conversation ${id}`)
    return this.withChat(found)
  }
  messages(id: string): ConversationMessage[] { this.get(id); return this.store.messages(id) }
  stages(id: string): ConversationStage[] { this.get(id); return this.store.stages(id) }
  branches(id: string): Promise<ProjectHead[]> {
    return Promise.all(this.get(id).projectPaths.map(async (projectPath) => ({ path: projectPath, ...await projectHead(projectPath) })))
  }
  changes(id: string): Promise<FolderChanges[]> {
    const starts = this.store.projectStarts(id)
    return Promise.all(this.get(id).projectPaths.map((project) => folderChanges(project, starts[project] ?? null)))
  }
  async diff(id: string, project: string, file: string): Promise<FileDiff> {
    if (!this.get(id).projectPaths.includes(project)) throw new Rejection('repo-not-found', `${project} is not one of the conversation's projects`)
    return folderDiff(project, file)
  }
  search(query: string): ConversationSearchHit[] {
    return this.store.searchMessages(query).map(({ conversationId, text }) => ({ conversationId, snippet: searchSnippet(text, query) }))
  }

  async create(agent: AgentKind, projectPaths: readonly string[], mode: ConversationMode = 'tui', allowBypass?: boolean): Promise<Conversation> {
    if (projectPaths.length > MAX_TASK_REPOS) throw new Rejection('too-many-projects')
    const projects: string[] = []
    const picked: string[] = []
    for (const rawPath of projectPaths) {
      const projectPath = normalizeRepoPath(rawPath)
      if (!(await stat(projectPath).catch(() => null))?.isDirectory()) {
        throw new Rejection('invalid-workspace', 'project must be an existing absolute directory')
      }
      const resolved = await realpath(projectPath)
      if (projects.includes(resolved)) throw new Rejection('duplicate-project')
      projects.push(resolved)
      picked.push(projectPath)
    }
    let workspace: string
    const id = randomUUID()
    if (projects.length === 0) {
      workspace = path.join(this.sessionsRoot, id, 'workspace')
      await mkdir(workspace, { recursive: true, mode: 0o700 })
    } else {
      workspace = projects[0]!
    }
    const starts: Record<string, string> = {}
    for (const project of projects) {
      const head = await folderHead(project)
      if (head) starts[project] = head
    }
    const created = this.store.create(agent, workspace, projects, id, starts)
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    // The paths as picked, not resolved: the same strings a task stores for them.
    this.projects.remember(picked)
    this.changed(created)
    return this.start(id, agent, '', false, mode)
  }

  rename(id: string, title: string): Conversation {
    this.get(id)
    return this.changed(this.store.update(id, { title: title.trim(), titleLocked: true }))
  }

  async continue(id: string, mode: ConversationMode = 'tui', allowBypass?: boolean): Promise<Conversation> {
    const current = this.get(id)
    if (current.sessionId || this.launching.has(id)) throw new Rejection('conversation-running')
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    return this.start(id, current.agent, '', false, mode)
  }

  async handoff(id: string, agent: AgentKind, note: string, stopRunning: boolean, mode: ConversationMode = 'tui', allowBypass?: boolean): Promise<Conversation> {
    const current = this.get(id)
    if (agent === current.agent) throw new Rejection('conversation-same-agent')
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && !stopRunning) throw new Rejection('conversation-running')
    if (current.sessionId) await this.stop(id)
    return this.start(id, agent, note, true, mode)
  }

  private async start(id: string, agent: AgentKind, note: string, handoff: boolean, mode: ConversationMode): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    this.launching.add(id)
    try {
      const current = this.get(id)
      if (current.sessionId) throw new Rejection('conversation-running')
      const previous = this.store.latestStage(id, agent)
      // Kando picks a Claude session id before launch, so a run that died before its first prompt
      // left an id Claude never saved. Only a session that recorded messages can be resumed.
      const saved = previous?.providerSessionId && (agent !== 'claude' || this.store.hasProviderMessages(id, previous.providerSessionId))
        ? previous.providerSessionId : null
      const providerSessionId = saved ?? (agent === 'claude' ? randomUUID() : null)
      const missingNativeSession = previous !== null && saved === null
      const messages = missingNativeSession ? this.store.messages(id) :
        handoff ? this.store.messages(id, previous?.receivedSequence ?? 0) : []
      const needsHandoff = handoff || (missingNativeSession && messages.length > 0)
      let handoffPath: string | null = null
      if (needsHandoff) {
        const directory = path.join(this.sessionsRoot, id, 'handoffs')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        handoffPath = path.join(directory, `${randomUUID()}.md`)
        await writeFile(handoffPath, buildHandoff(current, messages, note, current.agent, agent), { mode: 0o600 })
      }
      const stageId = randomUUID()
      const stage = this.store.startStage(id, agent, providerSessionId, this.store.maxSequence(id), stageId, mode)
      if (mode === 'chat') return await this.startChat(current, stage, saved !== null, handoffPath, handoff, previous !== null)
      const callback = this.callbackCommand(id, stage.id, agent)
      const command = conversationCommand(agent, providerSessionId, saved !== null, callback, handoffPath, current.projectPaths.slice(1))
      const marker = handoff ? `已从 ${current.agent} 移交给 ${agent}` : previous ? `继续 ${agent} 会话` : `开始 ${agent} 会话`
      this.transcript.marker(id, marker)
      let sessionId: string
      try {
        const spawned = await this.daemon.request('spawn', {
          command: command.command, args: command.args, cwd: current.workspacePath, env: {}, cols: 100, rows: 30
        })
        sessionId = spawned.sessionId
      } catch (error) {
        this.store.deleteStage(stage.id)
        this.transcript.marker(id, this.launchFailure(agent, command.command, error))
        throw error
      }
      this.store.attachStage(stage.id, sessionId)
      const updated = this.changed(this.store.update(id, { agent, sessionId, outputOffset: 0 }))
      // PTY may have written before spawn's reply reached core. A failed attach does not undo a running PTY.
      await this.recover(updated).catch((error: unknown) => console.error('[kando-core] conversation replay failed', error))
      return this.get(id)
    } finally {
      this.launching.delete(id)
    }
  }

  // Runs the stage's agent over stdio, driven by the chat host, and waits until it can take a message.
  private async startChat(
    current: Conversation,
    stage: ConversationStage,
    resume: boolean,
    handoffPath: string | null,
    handoff: boolean,
    continued: boolean
  ): Promise<Conversation> {
    const { id } = current
    const { agent } = stage
    const { options } = this.chatStage(current, stage)
    const command = chatCommand(agent, stage.providerSessionId, resume, handoffPath, current.projectPaths.slice(1), options)
    let sessionId: string
    try {
      ({ sessionId } = await this.daemon.request('spawnPipe', { command: command.command, args: command.args, cwd: current.workspacePath, env: {} }))
    } catch (error) {
      this.store.deleteStage(stage.id)
      this.transcript.marker(id, this.launchFailure(agent, command.command, error))
      throw error instanceof Rejection && error.reason === 'unknown-method'
        ? new Rejection('daemon-outdated', 'the running daemon predates chat mode; restart it')
        : error
    }
    this.store.attachStage(stage.id, sessionId)
    const marker = handoff ? `已从 ${current.agent} 移交给 ${agent}` : continued ? `继续 ${agent} 会话` : `开始 ${agent} 会话`
    this.transcript.marker(id, `${marker}（聊天界面，此段不在终端显示）`)
    this.changed(this.store.update(id, { agent, sessionId }))
    try {
      await this.chats.open(this.chatStage(current, stage), sessionId, 0, true)
      if (handoffPath) await this.chats.send(id, handoffPrompt(handoffPath))
    } catch (error) {
      // A stage that never started leaves nothing to resume, so it goes, log and all.
      this.chats.forget(sessionId, stage.id)
      await this.daemon.request('kill', { sessionId, force: true }).catch(() => {})
      this.store.deleteStage(stage.id)
      await rm(ChatLog.of(this.sessionsRoot, id, stage.id).file, { force: true })
      this.changed(this.store.update(id, { sessionId: null }))
      this.transcript.marker(id, `${agent} 聊天界面启动失败`)
      throw error
    }
    // Announced again now that the agent can take a message: clients learn it is idle.
    return this.changed(this.store.touch(id))
  }

  private launchFailure(agent: AgentKind, command: string, error: unknown): string {
    return error instanceof Rejection && error.reason === 'command-not-found'
      ? `${agent} 启动失败：找不到 ${command} 命令，请先安装并确认它在 PATH 里`
      : `${agent} 启动失败`
  }

  private chatStage(conversation: Conversation, stage: ConversationStage): ChatStage {
    const chosen = this.store.chatOptions(conversation.id)
    return {
      conversationId: conversation.id,
      stageId: stage.id,
      agent: stage.agent,
      options: {
        cwd: conversation.workspacePath,
        extraDirs: conversation.projectPaths.slice(1),
        resume: stage.providerSessionId,
        allowBypass: chosen.allowBypass ?? false,
        preferred: { permissionMode: chosen.permissionMode, ...chosen[stage.agent] }
      }
    }
  }

  // Remembered for the conversation's next start once the stage took it: a model or effort here,
  // a permission mode when the stage reports it (see rememberMode). With no agent running, only
  // remembered, from what the last chat stage offered.
  async setOption(id: string, option: ChatOption, value: string): Promise<void> {
    const conversation = this.get(id)
    const { agent } = conversation
    if (this.chats.activity(id) === null) {
      this.chooseForNextStart(conversation, option, value)
      return
    }
    await this.chats.setOption(id, option, value)
    if (option === 'permissionMode') return
    const chosen = this.store.chatOptions(id)
    this.store.setChatOptions(id, { [agent]: { ...chosen[agent], [option]: value } })
  }

  private chooseForNextStart(conversation: Conversation, option: ChatOption, value: string): void {
    const { id, agent } = conversation
    const stage = this.store.stages(id).filter((each) => each.mode === 'chat').at(-1)
    const state = stage?.agent === agent
      ? this.chats.items(this.chatStage(conversation, stage)).findLast((item) => item.kind === 'state')
      : undefined
    if (state?.kind !== 'state') throw new Rejection('chat-option-invalid', `no chat stage of ${agent} to take options from`)
    const chosen = this.store.chatOptions(id)
    const current = chosen[agent] ?? {}
    const model = (name: string | null | undefined) => state.models.find((each) => each.id === name)
    if (option === 'permissionMode') {
      // Bypass is for the start to allow, which asks the user's setting again.
      if (value !== 'bypass' && !state.permissionModes.includes(value)) throw new Rejection('chat-option-invalid', `${agent} offers no permission mode ${value}`)
      this.store.setChatOptions(id, { permissionMode: value })
    } else if (option === 'model') {
      const picked = model(value)
      if (!picked) throw new Rejection('chat-option-invalid', `${agent} lists no model ${value}`)
      // An effort the new model does not take would stop it from starting.
      const effort = current.effort && picked.efforts.includes(current.effort) ? current.effort : undefined
      this.store.setChatOptions(id, { [agent]: { model: value, effort } })
    } else {
      if (!model(current.model ?? state.model)?.efforts.includes(value)) throw new Rejection('chat-option-invalid', `the model takes no effort ${value}`)
      this.store.setChatOptions(id, { [agent]: { ...current, effort: value } })
    }
    this.changed(conversation)
  }

  // An idle chat agent goes after a while, so the ones open all day do not pile up; the next
  // message starts it again on the same session.
  async releaseIdle(now = Date.now()): Promise<void> {
    for (const id of this.chats.idleSince(now - CHAT_IDLE_MS)) {
      if (this.launching.has(id)) continue
      await this.stop(id).catch((error: unknown) => console.error('[kando-core] releasing an idle chat agent failed', error))
    }
  }

  // The mode the stage runs in, however it got there: a plan approved to carry out with edits
  // accepted leaves the conversation in acceptEdits, not in the plan mode the user picked.
  private rememberMode(conversationId: string, items: readonly ChatItem[]): void {
    const mode = items.findLast((item) => item.kind === 'state')
    if (mode?.kind !== 'state' || !mode.permissionMode) return
    if (this.store.chatOptions(conversationId).permissionMode !== mode.permissionMode) {
      this.store.setChatOptions(conversationId, { permissionMode: mode.permissionMode })
    }
  }

  async send(id: string, text: string, queue = false): Promise<void> {
    this.get(id)
    await this.chats.send(id, text, queue)
  }

  cancelQueued(id: string): void {
    this.get(id)
    this.chats.cancelQueued(id)
  }

  sendQueued(id: string): void {
    this.get(id)
    this.chats.sendQueued(id)
  }

  async respond(id: string, requestId: string, answer: ChatAnswer): Promise<void> {
    this.get(id)
    await this.chats.respond(id, requestId, answer)
  }

  async interrupt(id: string): Promise<void> {
    this.get(id)
    await this.chats.interrupt(id)
  }

  // The newest chat stages' items, oldest first; `before` pages further back.
  chatPage(id: string, before?: string): { items: ChatItem[]; before: string | null } {
    const conversation = this.get(id)
    const stages = this.store.stages(id).filter((stage) => stage.mode === 'chat')
    const until = before === undefined ? stages.length : stages.findIndex((stage) => stage.id === before)
    if (until < 0) throw new Rejection('stage-not-found', `no chat stage ${before}`)
    const pages: ChatItem[][] = []
    let count = 0
    let index = until
    while (index > 0 && (pages.length === 0 || count < CHAT_PAGE_ITEMS)) {
      index--
      const items = this.chats.items(this.chatStage(conversation, stages[index]!))
      pages.unshift(items)
      count += items.length
    }
    return { items: pages.flat(), before: index > 0 ? stages[index]!.id : null }
  }

  isChatSession(sessionId: string): boolean {
    return this.store.stageBySession(sessionId)?.mode === 'chat'
  }

  async stop(id: string): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (!current.sessionId) return current
    if (this.store.activeStage(id)?.mode === 'chat') {
      await this.stopChat(current.sessionId)
      if (this.store.get(id)?.sessionId === null) return this.get(id)
    } else {
      await this.daemon.request('kill', { sessionId: current.sessionId })
    }
    const stage = this.store.activeStage(id)
    if (stage) this.store.endStage(stage.id, null)
    this.transcript.marker(id, '会话已停止')
    return this.changed(this.store.update(id, { sessionId: null }))
  }

  // A chat agent is gone only once the daemon says so: clearing the session any earlier would let a
  // continue start a second writer on the same Claude session or Codex thread.
  private async stopChat(sessionId: string): Promise<void> {
    const exited = new Promise<void>((resolve) => this.exitWaiters.set(sessionId, resolve))
    this.stopping.add(sessionId)
    await this.daemon.request('kill', { sessionId })
    if (!(await settles(exited, STOP_GRACE_MS))) {
      await this.daemon.request('kill', { sessionId, force: true }).catch(() => {})
      await settles(exited, KILL_GRACE_MS)
    }
    this.exitWaiters.delete(sessionId)
    this.stopping.delete(sessionId)
  }

  async delete(id: string): Promise<void> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (current.sessionId) await this.stop(id)
    const directory = path.join(this.sessionsRoot, id)
    await rm(path.join(directory, 'terminal.log'), { force: true })
    await rm(path.join(directory, 'handoffs'), { recursive: true, force: true })
    await rm(path.join(directory, 'stages'), { recursive: true, force: true })
    this.store.delete(id)
    this.emit({ type: 'deleted', id })
  }

  history(id: string, offset: number, length: number) {
    this.get(id)
    return { ...this.transcript.read(id, offset, length), sessionOffset: this.store.outputOffset(id) }
  }

  recordEvent(input: {
    id: string; stageId: string; agent: AgentKind; providerSessionId: string | null;
    role: 'user' | 'assistant'; text: string; eventKey: string; complete: boolean
  }): void {
    const conversation = this.get(input.id)
    const stage = this.store.stage(input.stageId)
    if (!stage || stage.conversationId !== input.id || stage.agent !== input.agent) throw new Rejection('conversation-event-invalid')
    if (input.providerSessionId) {
      if (stage.providerSessionId && stage.providerSessionId !== input.providerSessionId) throw new Rejection('conversation-event-invalid')
      this.store.setProviderSession(stage.id, input.providerSessionId)
    }
    this.recordStageMessage(conversation, stage, input)
  }

  private recordChatMessage(chat: ChatStage, message: StageMessage): void {
    const conversation = this.store.get(chat.conversationId)
    const stage = this.store.stage(chat.stageId)
    if (conversation && stage) this.recordStageMessage(conversation, stage, message)
  }

  // Shared by hook reports and chat stages: the message itself, then what it says about the rest.
  private recordStageMessage(conversation: Conversation, stage: ConversationStage, message: StageMessage): void {
    const text = message.text.trim()
    if (!text || (message.role === 'user' && this.isHandoffPrompt(conversation.id, text))) return
    const saved = this.store.addMessage({
      conversationId: conversation.id, stageId: stage.id, role: message.role, agent: stage.agent,
      text, eventKey: message.eventKey, complete: message.complete
    })
    if (!saved) return
    if (message.role === 'assistant' && message.complete) this.store.completePendingUsers(stage.id)
    if (message.role === 'user' && !conversation.titleLocked && conversation.title === '新会话') {
      const first = text.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' ')).find(Boolean)
      if (first) {
        this.changed(this.store.update(conversation.id, { title: [...first].slice(0, 40).join('') }))
        return
      }
    }
    this.changed(this.store.touch(conversation.id))
  }

  handleData(event: Extract<DaemonEvent, { event: 'data' }>): void {
    if (this.chats.handleData(event.sessionId, event.offset, event.data)) return
    const current = this.store.bySession(event.sessionId)
    if (!current) return
    // Chat output before the host has opened the stage (core just restarted): open() reads it
    // from the daemon's buffer, and it is JSON, not terminal output.
    if (this.isChatSession(event.sessionId)) return
    const cursor = this.store.outputOffset(current.id)
    const start = Math.max(0, cursor - event.offset)
    if (start < event.data.length) {
      if (event.offset > cursor) this.transcript.marker(current.id, 'daemon 缓存之外的终端输出已丢失')
      this.transcript.append(current.id, event.data.slice(start))
      this.store.update(current.id, { outputOffset: event.offset + event.data.length })
    }
  }

  handleStderr(sessionId: string, data: string): void {
    this.chats.handleStderr(sessionId, data)
  }

  handleExit(sessionId: string, exitCode: number): void {
    this.chats.handleExit(sessionId, exitCode)
    const stopped = this.stopping.has(sessionId)
    const current = this.store.bySession(sessionId)
    if (current) {
      const stage = this.store.activeStage(current.id)
      if (stage?.sessionId === sessionId) this.store.endStage(stage.id, stopped ? null : exitCode)
      this.transcript.marker(current.id, stopped ? '会话已停止' : `agent 已退出，code ${exitCode}`)
      this.changed(this.store.update(current.id, { sessionId: null }))
    }
    this.exitWaiters.get(sessionId)?.()
  }

  // Every session the daemon still knows is drained before it counts as ended, so output from
  // while core was down is kept; only one the daemon never heard of ended unseen.
  async reconcile(sessions: readonly SessionInfo[]): Promise<void> {
    const known = new Map(sessions.map((session) => [session.sessionId, session]))
    for (const conversation of this.store.list()) {
      if (!conversation.sessionId) continue
      const info = known.get(conversation.sessionId)
      try {
        const stage = this.store.activeStage(conversation.id)
        if (!info) {
          if (stage) this.store.endStage(stage.id, null)
          this.changed(this.store.update(conversation.id, { sessionId: null }))
        } else if (stage?.mode === 'chat') {
          await this.chats.open(this.chatStage(conversation, stage), info.sessionId, this.store.chatOffset(stage.id), false)
          if (info.exited) this.handleExit(info.sessionId, info.exitCode ?? -1)
        } else {
          await this.recover(conversation)
        }
      } catch (error) {
        console.error(`[kando-core] recovering conversation ${conversation.id} failed`, error)
      }
    }
  }

  private async recover(conversation: Conversation): Promise<void> {
    if (!conversation.sessionId) return
    const attached = await this.daemon.request('attach', { sessionId: conversation.sessionId })
    const cursor = this.store.outputOffset(conversation.id)
    if (attached.bufferStart > cursor) {
      this.transcript.marker(conversation.id, 'daemon 缓存之外的终端输出已丢失')
      this.store.update(conversation.id, { outputOffset: attached.bufferStart })
    }
    const start = Math.max(cursor, attached.bufferStart)
    if (start < attached.endOffset) {
      this.transcript.append(conversation.id, attached.buffer.slice(start - attached.bufferStart))
      this.store.update(conversation.id, { outputOffset: attached.endOffset })
    }
    if (attached.exited) this.handleExit(conversation.sessionId, attached.exitCode ?? 0)
  }

  // Kando's own instruction, not something the user said: kept out of the title, search and later handoffs.
  private isHandoffPrompt(id: string, text: string): boolean {
    const handoffPath = handoffPromptPath(text)
    return handoffPath !== null && path.dirname(handoffPath) === path.join(this.sessionsRoot, id, 'handoffs')
  }

  private withChat(conversation: Conversation): Conversation {
    const turn = conversation.sessionId ? this.chats.activity(conversation.id) : null
    const chosen = this.store.chatOptions(conversation.id)
    const chatOptions = {
      permissionMode: chosen.permissionMode ?? null,
      model: chosen[conversation.agent]?.model ?? null,
      effort: chosen[conversation.agent]?.effort ?? null
    }
    return { ...conversation, chat: turn ? { turn } : null, chatOptions }
  }

  private changed(value: Conversation): Conversation {
    const decorated = this.withChat(value)
    this.emit({ type: 'changed', conversation: decorated })
    return decorated
  }
}
