import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MAX_TASK_REPOS, type AgentKind, type Conversation, type ConversationMessage, type ConversationSearchHit, type ConversationStage } from '@kando/protocol'
import type { DaemonEvent, SessionInfo } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'
import { ConversationStore } from './conversation-store'
import { conversationCommand } from './conversation-command'
import { searchSnippet } from './conversation-search'
import { buildHandoff } from './conversation-handoff'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { TerminalTranscript } from './terminal-transcript'
import { normalizeRepoPath } from './workspace'

type ConversationEvent = { type: 'changed'; conversation: Conversation } | { type: 'deleted'; id: string }

export class ConversationService {
  private readonly launching = new Set<string>()
  private readonly transcript: TerminalTranscript

  constructor(
    private readonly store: ConversationStore,
    private readonly daemon: SessionHost,
    private readonly sessionsRoot: string,
    private readonly callbackCommand: (conversationId: string, stageId: string, agent: AgentKind) => string[],
    private readonly emit: (event: ConversationEvent) => void,
    private readonly projects: ProjectRegistry
  ) {
    this.transcript = new TerminalTranscript(sessionsRoot)
  }

  list(): Conversation[] { return this.store.list() }
  get(id: string): Conversation {
    const found = this.store.get(id)
    if (!found) throw new Rejection('conversation-not-found', `no conversation ${id}`)
    return found
  }
  messages(id: string): ConversationMessage[] { this.get(id); return this.store.messages(id) }
  stages(id: string): ConversationStage[] { this.get(id); return this.store.stages(id) }
  search(query: string): ConversationSearchHit[] {
    return this.store.searchMessages(query).map(({ conversationId, text }) => ({ conversationId, snippet: searchSnippet(text, query) }))
  }

  async create(agent: AgentKind, projectPaths: readonly string[]): Promise<Conversation> {
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
    const created = this.store.create(agent, workspace, projects, id)
    // The paths as picked, not resolved: the same strings a task stores for them.
    this.projects.remember(picked)
    this.changed(created)
    return this.start(id, agent, '', false)
  }

  rename(id: string, title: string): Conversation {
    this.get(id)
    return this.changed(this.store.update(id, { title: title.trim(), titleLocked: true }))
  }

  async continue(id: string): Promise<Conversation> {
    const current = this.get(id)
    if (current.sessionId || this.launching.has(id)) throw new Rejection('conversation-running')
    return this.start(id, current.agent, '', false)
  }

  async handoff(id: string, agent: AgentKind, note: string, stopRunning: boolean): Promise<Conversation> {
    const current = this.get(id)
    if (agent === current.agent) throw new Rejection('conversation-same-agent')
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && !stopRunning) throw new Rejection('conversation-running')
    if (current.sessionId) await this.stop(id)
    return this.start(id, agent, note, true)
  }

  private async start(id: string, agent: AgentKind, note: string, handoff: boolean): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    this.launching.add(id)
    try {
      const current = this.get(id)
      if (current.sessionId) throw new Rejection('conversation-running')
      const previous = this.store.latestStage(id, agent)
      const providerSessionId = agent === 'claude' ? previous?.providerSessionId ?? randomUUID() : previous?.providerSessionId ?? null
      const missingNativeSession = previous !== null && previous.providerSessionId === null
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
      const stage = this.store.startStage(id, agent, providerSessionId, this.store.maxSequence(id), stageId)
      const callback = this.callbackCommand(id, stage.id, agent)
      const command = conversationCommand(agent, providerSessionId, previous?.providerSessionId !== undefined && previous.providerSessionId !== null, callback, handoffPath, current.projectPaths.slice(1))
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
        this.transcript.marker(id, `${agent} 启动失败`)
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

  async stop(id: string): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (!current.sessionId) return current
    await this.daemon.request('kill', { sessionId: current.sessionId })
    const stage = this.store.activeStage(id)
    if (stage) this.store.endStage(stage.id, null)
    this.transcript.marker(id, '会话已停止')
    return this.changed(this.store.update(id, { sessionId: null }))
  }

  async delete(id: string): Promise<void> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (current.sessionId) await this.stop(id)
    const directory = path.join(this.sessionsRoot, id)
    await rm(path.join(directory, 'terminal.log'), { force: true })
    await rm(path.join(directory, 'handoffs'), { recursive: true, force: true })
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
    const text = input.text.trim()
    if (!text) return
    const saved = this.store.addMessage({
      conversationId: input.id, stageId: stage.id, role: input.role, agent: input.agent,
      text, eventKey: input.eventKey, complete: input.complete
    })
    if (!saved) return
    if (input.role === 'assistant' && input.complete) this.store.completePendingUsers(stage.id)
    if (input.role === 'user' && !conversation.titleLocked && conversation.title === '新会话') {
      const first = text.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' ')).find(Boolean)
      if (first) {
        this.changed(this.store.update(input.id, { title: [...first].slice(0, 40).join('') }))
        return
      }
    }
    this.changed(this.store.touch(input.id))
  }

  handleData(event: Extract<DaemonEvent, { event: 'data' }>): void {
    const current = this.store.bySession(event.sessionId)
    if (!current) return
    const cursor = this.store.outputOffset(current.id)
    const start = Math.max(0, cursor - event.offset)
    if (start < event.data.length) {
      if (event.offset > cursor) this.transcript.marker(current.id, 'daemon 缓存之外的终端输出已丢失')
      this.transcript.append(current.id, event.data.slice(start))
      this.store.update(current.id, { outputOffset: event.offset + event.data.length })
    }
  }

  handleExit(sessionId: string, exitCode: number): void {
    const current = this.store.bySession(sessionId)
    if (!current) return
    const stage = this.store.activeStage(current.id)
    if (stage?.sessionId === sessionId) this.store.endStage(stage.id, exitCode)
    this.transcript.marker(current.id, `agent 已退出，code ${exitCode}`)
    this.changed(this.store.update(current.id, { sessionId: null }))
  }

  async reconcile(sessions: readonly SessionInfo[]): Promise<void> {
    const live = new Set(sessions.filter((session) => !session.exited).map((session) => session.sessionId))
    for (const conversation of this.store.list()) {
      if (!conversation.sessionId) continue
      if (!live.has(conversation.sessionId)) {
        const stage = this.store.activeStage(conversation.id)
        if (stage) this.store.endStage(stage.id, null)
        this.changed(this.store.update(conversation.id, { sessionId: null }))
      } else {
        await this.recover(conversation)
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

  private changed(value: Conversation): Conversation {
    this.emit({ type: 'changed', conversation: value })
    return value
  }
}
