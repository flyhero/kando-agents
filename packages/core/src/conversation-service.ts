import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkEditAdditionalProjects, checkSwitchBranch, isPlanApproval, MAX_TASK_REPOS, type AgentKind, type ChatCatalog, type ChatImage, type ChatItem, type ChatOption, type CommitPushResult, type Conversation, type ConversationMessage, type ConversationMode, type ConversationSearchHit, type ConversationStage, type FileDiff, type FolderChanges, type ProjectBranches, type ProjectHead, type ChatDecision, isKandoRequest } from '@kando/protocol'
import type { DaemonEvent, SessionInfo } from '@kando/protocol/node'
import type { RunMeasure } from './agent-run-store'
import type { AttachmentStore } from './attachment-store'
import type { ChatAnswer, StageMessage } from './chat-driver'
import { catalogOf, probeChatCatalog } from './chat-catalog'
import { ChatHost, createDriver, type ChatStage } from './chat-host'
import { ChatLog } from './chat-log'
import type { SessionHost } from './daemon-client'
import { ConversationStore } from './conversation-store'
import { folderChanges, folderDiff, folderHead } from './conversation-changes'
import { CLAUDE_MODE_NAMES } from './claude-stream'
import { CODEX_MODES } from './codex-app-server'
import type { McpServer } from './agent-command'
import { chatCommand, conversationCommand, handoffPrompt, handoffPromptPath } from './conversation-command'
import { searchSnippet } from './conversation-search'
import { buildHandoff } from './conversation-handoff'
import { createProjectBranch, projectBranches, switchProjectBranch } from './project-branches'
import { commitAndPush } from './project-commit'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { TerminalTranscript } from './terminal-transcript'
import type { UsageReport } from './usage-source'
import { normalizeRepoPath, projectHead } from './workspace'

export type ConversationEvent =
  | { type: 'changed'; conversation: Conversation }
  | { type: 'deleted'; id: string }
  | { type: 'chatItems'; conversationId: string; items: ChatItem[] }
  | { type: 'chatDelta'; conversationId: string; stageId: string; itemId: string; append: string }
  // A plan approved in a task's chat, for the task to keep as the one it carries out.
  | { type: 'planApproved'; taskId: string; plan: { markdown: string; agent: AgentKind; stageId: string; requestId: string } }
  // A running chat agent reported its account's limits.
  | { type: 'usage'; agent: AgentKind; report: UsageReport }

export type ChatStageRef = { conversationId: string; taskId: string | null; stageId: string; agent: AgentKind; ended: boolean }

// How a task's chat starts a stage: where its agent works (worktrees once the task runs, its projects
// while it only plans), and whether it goes on with the last session or takes one of its own (a first
// start, or planning giving way to carrying the plan out).
export type TaskChatLaunch = {
  cwd: string
  extraDirs: readonly string[]
  planOnly: boolean
  session: 'new' | 'resume'
  // Files the agent may read without asking, such as the task's images.
  readable?: readonly string[]
  allowBypass?: boolean
}

// What a stage's start takes beyond the agent: see TaskChatLaunch; moved says the agent works
// somewhere else than its last stage did.
type StageLaunch = { fresh?: boolean; moved?: boolean; planOnly?: boolean; readable?: readonly string[] }

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

// How the note of a branch switch begins, which Kando puts before the user's next message.
const SWITCH_NOTE = '（我切换了分支：'

// Each an existing directory, by its real path and as picked; `taken` are real paths already in use.
async function resolveProjects(projectPaths: readonly string[], taken: readonly string[] = []): Promise<{ projects: string[]; picked: string[] }> {
  const projects: string[] = []
  const picked: string[] = []
  for (const rawPath of projectPaths) {
    const projectPath = normalizeRepoPath(rawPath)
    if (!(await stat(projectPath).catch(() => null))?.isDirectory()) {
      throw new Rejection('invalid-workspace', 'project must be an existing absolute directory')
    }
    const resolved = await realpath(projectPath)
    if (projects.includes(resolved) || taken.includes(resolved)) throw new Rejection('duplicate-project')
    projects.push(resolved)
    picked.push(projectPath)
  }
  return { projects, picked }
}

export class ConversationService {
  private readonly tuiWorking = new Map<string, boolean>()
  // Core's chat settings say; main hands them over before any stage starts.
  private promptSuggestions = false
  private readonly launching = new Set<string>()
  private readonly catalogs = new Map<AgentKind, Promise<ChatCatalog | null>>()
  private readonly transcript: TerminalTranscript
  private readonly chats: ChatHost
  // Sessions being stopped on purpose: their exit reads as a stop, not a crash.
  private readonly stopping = new Set<string>()
  private readonly exitWaiters = new Map<string, () => void>()
  // Kando's own questions waiting on the user, by request id.
  private readonly asks = new Map<string, { resolve: (decision: ChatDecision) => void; reject: (error: Error) => void }>()

  constructor(
    private readonly store: ConversationStore,
    private readonly daemon: SessionHost,
    private readonly sessionsRoot: string,
    private readonly callbackCommand: (conversationId: string, stageId: string, agent: AgentKind) => string[],
    private readonly emit: (event: ConversationEvent) => void,
    private readonly projects: ProjectRegistry,
    private readonly attachments: AttachmentStore,
    // Kando's MCP server for a chat's agent, acting for that conversation; null leaves the agent
    // without Kando's tools.
    private readonly mcp: ((conversationId: string) => McpServer) | null = null
  ) {
    this.transcript = new TerminalTranscript(sessionsRoot)
    this.chats = new ChatHost(daemon, sessionsRoot, attachments, {
      items: (conversationId, items) => {
        this.rememberMode(conversationId, items)
        this.rememberCatalog(conversationId, items)
        this.settleAsks(items)
        this.emit({ type: 'chatItems', conversationId, items })
      },
      delta: (conversationId, stageId, itemId, append) => this.emit({ type: 'chatDelta', conversationId, stageId, itemId, append }),
      messages: (stage, messages) => messages.forEach((message) => this.recordChatMessage(stage, message)),
      provider: (stage, providerSessionId) => this.store.setProviderSession(stage.stageId, providerSessionId),
      activity: (conversationId) => {
        const current = this.store.get(conversationId)
        if (current) this.changed(current)
      },
      offset: (stageId, end) => this.store.setChatOffset(stageId, end),
      usage: (stage, report) => this.emit({ type: 'usage', agent: stage.agent, report })
    })
  }

  // Takes effect in running chats at once: off pauses their suggestions and takes away the one
  // showing; on resumes them in an agent started with them, and the rest have them from their next start.
  setPromptSuggestions(enabled: boolean): void {
    if (enabled === this.promptSuggestions) return
    this.promptSuggestions = enabled
    const showing = this.store.list().filter((conversation) => this.chats.suggestion(conversation.id) !== null)
    this.chats.pauseSuggestions(!enabled)
    showing.forEach((conversation) => this.changed(conversation))
  }

  // The free conversations; a task's own is reached through its task.
  list(): Conversation[] { return this.store.list().filter((conversation) => !conversation.taskId).map((conversation) => this.withChat(conversation)) }
  get(id: string): Conversation {
    const found = this.store.get(id)
    if (!found) throw new Rejection('conversation-not-found', `no conversation ${id}`)
    return this.withChat(found)
  }
  messages(id: string): ConversationMessage[] { this.get(id); return this.store.messages(id) }
  stages(id: string): ConversationStage[] { this.get(id); return this.store.stages(id) }

  // What a task's run cost in its chat: the turns that ended between `from` and `to`, across however
  // many stages the run spanned, and the model and effort the last of them reported. null when the
  // conversation is gone.
  runUsage(id: string, from: number, to: number): RunMeasure | null {
    const conversation = this.store.get(id)
    if (!conversation) return null
    const stages = this.store.stages(id).filter((stage) => stage.mode === 'chat' && stage.startedAt <= to && (stage.endedAt === null || stage.endedAt >= from))
    const sum = { input: 0, output: 0, total: 0, work: 0, split: false, lumped: false, counted: false, timed: false }
    let state: ChatItem | undefined
    for (const stage of stages) {
      const items = this.chats.items(this.chatStage(conversation, stage))
      for (const item of items) {
        if (item.kind !== 'turn' || item.at < from || item.at > to) continue
        if (item.durationMs !== null) { sum.work += item.durationMs; sum.timed = true }
        if (!item.usage) continue
        sum.counted = true
        if ('total' in item.usage) { sum.total += item.usage.total; sum.lumped = true }
        else { sum.input += item.usage.input; sum.output += item.usage.output; sum.total += item.usage.input + item.usage.output; sum.split = true }
      }
      state = items.findLast((item) => item.kind === 'state') ?? state
    }
    return {
      model: state?.kind === 'state' ? state.model : null,
      effort: state?.kind === 'state' ? state.effort : null,
      // Split only when every counted turn said which way its tokens went.
      inputTokens: sum.split && !sum.lumped ? sum.input : null,
      outputTokens: sum.split && !sum.lumped ? sum.output : null,
      totalTokens: sum.counted ? sum.total : null,
      workMs: sum.timed ? sum.work : null
    }
  }
  branches(id: string): Promise<ProjectHead[]> {
    return Promise.all(this.get(id).projectPaths.map(async (projectPath) => ({ path: projectPath, ...await projectHead(projectPath) })))
  }
  // Other conversations with an agent open in a folder see its files change with a switch.
  async branchOptions(id: string): Promise<ProjectBranches[]> {
    const conversation = this.get(id)
    const live = this.store.list().filter((other) => other.id !== id && other.sessionId !== null)
    return Promise.all(conversation.projectPaths.map(async (project) => ({
      path: project,
      ...await projectBranches(project),
      sharedWith: live.filter((other) => other.projectPaths.includes(project)).map((other) => other.title)
    })))
  }

  async switchBranch(id: string, project: string, ref: string): Promise<Conversation> {
    return this.branched(id, project, (dir) => switchProjectBranch(dir, ref))
  }

  async createBranch(id: string, project: string, name: string): Promise<Conversation> {
    return this.branched(id, project, (dir) => createProjectBranch(dir, name))
  }

  async commitPush(id: string, project: string, message: string): Promise<CommitPushResult> {
    const conversation = this.get(id)
    const blocker = checkSwitchBranch(conversation)
    if (blocker) throw new Rejection(blocker)
    if (!conversation.projectPaths.includes(project)) throw new Rejection('repo-not-found', `${project} is not one of the conversation's projects`)
    return commitAndPush(project, message)
  }

  // Only while no agent works in the folder (checkSwitchBranch). The conversation's changes then
  // count from the new HEAD, and its agent hears of the switch with the next message it is sent.
  private async branched(id: string, project: string, change: (dir: string) => Promise<string>): Promise<Conversation> {
    const conversation = this.get(id)
    const blocker = checkSwitchBranch(conversation)
    if (blocker) throw new Rejection(blocker)
    if (!conversation.projectPaths.includes(project)) throw new Rejection('repo-not-found', `${project} is not one of the conversation's projects`)
    const branch = await change(project)
    const head = await folderHead(project)
    if (head) this.store.setProjectStart(id, project, head)
    this.store.setSwitchedBranches(id, { ...this.store.switchedBranches(id), [project]: branch })
    return this.changed(this.get(id))
  }

  // What the user switched since the agent last heard, said before their next message.
  private switchNote(id: string): string | null {
    const switched = Object.entries(this.store.switchedBranches(id))
    if (switched.length === 0) return null
    const lines = switched.map(([project, branch]) => `${path.basename(project)} 现在在分支 ${branch}`)
    return `${SWITCH_NOTE}${lines.join('；')}。文件已经变了，需要时请重新读。）`
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

  async create(
    agent: AgentKind,
    projectPaths: readonly string[],
    mode: ConversationMode = 'tui',
    allowBypass?: boolean,
    start: { permissionMode?: string; model?: string; effort?: string } = {}
  ): Promise<Conversation> {
    if (projectPaths.length > MAX_TASK_REPOS) throw new Rejection('too-many-projects')
    const { permissionMode, model, effort } = start
    // Before the agent lists what it offers, only the modes it has at all; bypass still needs allowing.
    if (permissionMode && !(permissionMode in (agent === 'claude' ? CLAUDE_MODE_NAMES : CODEX_MODES))) {
      throw new Rejection('chat-option-invalid', `${agent} has no permission mode ${permissionMode}`)
    }
    if (model || effort) {
      const models = (await this.chatCatalog(agent))?.models ?? []
      const picked = models.find((each) => each.id === (model ?? models.find((one) => one.isDefault)?.id))
      if (model && !picked) throw new Rejection('chat-option-invalid', `${agent} lists no model ${model}`)
      if (effort && !picked?.efforts.includes(effort)) throw new Rejection('chat-option-invalid', `the model takes no effort ${effort}`)
    }
    const { projects, picked } = await resolveProjects(projectPaths)
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
    if (permissionMode) this.store.setChatOptions(id, { permissionMode })
    if (model || effort) this.store.setChatOptions(id, { [agent]: { model, effort } })
    // The paths as picked, not resolved: the same strings a task stores for them.
    this.projects.remember(picked)
    this.changed(created)
    return this.start(id, agent, '', false, mode)
  }

  // Everything but the primary changes (checkEditAdditionalProjects). A chat agent is given its
  // directories at launch, so an idle one restarts and goes on from where it was, as after /add-dir.
  async setAdditionalProjects(id: string, projectPaths: readonly string[]): Promise<Conversation> {
    const conversation = this.free(id)
    const blocker = this.launching.has(id) ? 'conversation-running' : checkEditAdditionalProjects(conversation)
    if (blocker) throw new Rejection(blocker)
    const primary = conversation.workspacePath
    const { projects, picked } = await resolveProjects(projectPaths, [primary])
    const next = [primary, ...projects]
    if (next.join('\n') === conversation.projectPaths.join('\n')) return conversation
    const live = conversation.sessionId !== null
    if (live && !this.chats.idle(id)) throw new Rejection('chat-busy', 'the agent is still working')
    if (live) await this.stop(id)
    this.store.moveWorkspace(id, primary, next)
    const starts = this.store.projectStarts(id)
    for (const project of projects) {
      const head = starts[project] ? null : await folderHead(project)
      if (head) this.store.setProjectStart(id, project, head)
    }
    this.projects.remember(picked)
    return live ? this.start(id, conversation.agent, '', false, 'chat') : this.changed(this.get(id))
  }

  // A task's chat is driven from its task, which checks what the task may do first.
  private free(id: string): Conversation {
    const conversation = this.get(id)
    if (conversation.taskId) throw new Rejection('task-conversation', 'this conversation runs a task; go on from the task')
    return conversation
  }

  // A task's chat: made on the task's first start, then moved to wherever its agent works next.
  // Resolves once the agent can take a message, which the task then sends.
  async startForTask(task: { id: string; title: string; agent: AgentKind }, launch: TaskChatLaunch): Promise<Conversation> {
    const cwd = await realpath(launch.cwd)
    const extraDirs = await Promise.all(launch.extraDirs.map((dir) => realpath(dir)))
    const projectPaths = [cwd, ...extraDirs]
    const conversation = this.store.byTask(task.id)
      ?? this.store.create(task.agent, cwd, projectPaths, randomUUID(), {}, { id: task.id, title: task.title })
    const { id } = conversation
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    // Another cwd is another place for the agent; only the directories it was given changed, the
    // agent restarts with them but goes on from where it was, as it would take /add-dir.
    const moved = conversation.workspacePath !== cwd
    const regrouped = moved || conversation.projectPaths.join('\n') !== projectPaths.join('\n')
    const live = conversation.sessionId !== null && this.chats.activity(id) !== null
    const same = !regrouped && conversation.agent === task.agent && (conversation.planOnly ?? false) === launch.planOnly
    if (live && launch.session === 'resume' && same) return this.withChat(conversation)
    if (conversation.sessionId && !this.chats.idle(id)) throw new Rejection('chat-busy', 'the agent is still working')
    if (conversation.sessionId) await this.stop(id)
    if (regrouped) this.store.moveWorkspace(id, cwd, projectPaths)
    if (conversation.title !== task.title) this.store.update(id, { title: task.title })
    if (launch.allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass: launch.allowBypass })
    // A stage of its own plans first; one going on keeps the mode it was left in.
    if (launch.session === 'new') this.store.setChatOptions(id, { permissionMode: 'plan' })
    return this.start(id, task.agent, '', false, 'chat', {
      fresh: launch.session === 'new',
      moved,
      planOnly: launch.planOnly,
      readable: launch.readable
    })
  }

  // Keeps a plan-only stage's plan: answers it, if it still waits, so the agent does not carry it
  // out, and gives what it said for the task to keep.
  async savePlan(conversationId: string, stageId: string, requestId: string): Promise<{ markdown: string; agent: AgentKind }> {
    const conversation = this.get(conversationId)
    const stage = this.store.stages(conversationId).find((each) => each.id === stageId)
    if (!stage) throw new Rejection('stage-not-found', `no stage ${stageId}`)
    if (!stage.planOnly) throw new Rejection('not-planning', 'only a stage that may only plan keeps its plan for later')
    const item = this.chats.items(this.chatStage(conversation, stage)).find((each) => each.kind === 'approval' && each.requestId === requestId)
    if (item?.kind !== 'approval' || !isPlanApproval(item) || !item.detail) throw new Rejection('chat-request-gone', 'no such plan')
    if (item.resolution === null && this.store.activeStage(conversationId)?.id === stageId) {
      await this.chats.respond(conversationId, requestId, { decision: 'deny', saved: true })
    }
    return { markdown: item.detail, agent: stage.agent }
  }

  rename(id: string, title: string): Conversation {
    this.get(id)
    return this.changed(this.store.update(id, { title: title.trim(), titleLocked: true }))
  }

  // An idle chat agent makes way for the terminal without the user stopping it first.
  async continue(id: string, mode: ConversationMode = 'tui', allowBypass?: boolean): Promise<Conversation> {
    const current = this.free(id)
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && mode === 'chat' && this.chats.activity(id) !== null) return current
    if (current.sessionId && !this.chats.idle(id)) throw new Rejection('conversation-running')
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (current.sessionId) await this.stop(id)
    return this.start(id, current.agent, '', false, mode)
  }

  async handoff(id: string, agent: AgentKind, note: string, stopRunning: boolean, mode: ConversationMode = 'tui', allowBypass?: boolean): Promise<Conversation> {
    const current = this.free(id)
    if (agent === current.agent) throw new Rejection('conversation-same-agent')
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && !stopRunning && !this.chats.idle(id)) throw new Rejection('conversation-running')
    if (current.sessionId) await this.stop(id)
    return this.start(id, agent, note, true, mode)
  }

  private async start(id: string, agent: AgentKind, note: string, handoff: boolean, mode: ConversationMode, launch: StageLaunch = {}): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    this.launching.add(id)
    try {
      const current = this.get(id)
      if (current.sessionId) throw new Rejection('conversation-running')
      const previous = launch.fresh ? null : this.store.latestStage(id, agent)
      // Kando picks a Claude session id before launch, so a run that died before its first prompt
      // left an id Claude never saved. Only a session that recorded messages can be resumed, and
      // only from the folder it ran in: moved elsewhere, Claude starts afresh from a handoff.
      const resumable = !(launch.moved && agent === 'claude')
      const saved = resumable && previous?.providerSessionId && (agent !== 'claude' || this.store.hasProviderMessages(id, previous.providerSessionId))
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
      const stage = this.store.startStage(id, agent, providerSessionId, this.store.maxSequence(id), stageId, mode, launch.planOnly ?? false)
      if (mode === 'chat') return await this.startChat(current, stage, saved !== null, handoffPath, handoff, previous !== null, launch.readable ?? [])
      // A terminal agent cannot be told of a switch; the user tells it, so a later chat does not.
      this.store.setSwitchedBranches(id, {})
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
      this.tuiWorking.set(id, true)
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
    continued: boolean,
    readable: readonly string[]
  ): Promise<Conversation> {
    const { id } = current
    const { agent } = stage
    const { options } = this.chatStage(current, stage)
    const command = chatCommand(agent, stage.providerSessionId, resume, handoffPath, options.extraDirs, {
      preferred: options.preferred,
      allowBypass: options.allowBypass,
      planOnly: options.planOnly ? { dirs: [options.cwd, ...options.extraDirs] } : undefined,
      readable,
      ...(this.mcp ? { mcp: this.mcp(id) } : {})
    })
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
        // Read off the stage, so a stage taken back after a restart still only plans.
        planOnly: stage.planOnly ?? false,
        allowBypass: !stage.planOnly && (chosen.allowBypass ?? false),
        promptSuggestions: this.promptSuggestions,
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

  // What a new chat can pick from before its agent starts: the models the agent listed last,
  // kept as each chat stage reports them, read back from the newest stage after a restart, and
  // asked of the CLI only when it never ran a chat.
  chatCatalog(agent: AgentKind): Promise<ChatCatalog | null> {
    const known = this.catalogs.get(agent)
    if (known) return known
    const found = this.catalogFromStages(agent)
    const catalog = found ? Promise.resolve(found) : probeChatCatalog(
      createDriver({ conversationId: '', stageId: 'catalog', agent, options: { cwd: this.sessionsRoot, extraDirs: [], resume: null } }),
      chatCommand(agent, null, false, null),
      this.sessionsRoot
    )
    this.catalogs.set(agent, catalog)
    // A probe that failed is tried again next time rather than remembered.
    void catalog.then((result) => {
      if (!result && this.catalogs.get(agent) === catalog) this.catalogs.delete(agent)
    })
    return catalog
  }

  private catalogFromStages(agent: AgentKind): ChatCatalog | null {
    const stage = this.store.latestChatStage(agent)
    const conversation = stage ? this.store.get(stage.conversationId) : null
    return stage && conversation ? catalogOf(this.chats.items(this.chatStage(this.withChat(conversation), stage))) : null
  }

  private rememberCatalog(conversationId: string, items: readonly ChatItem[]): void {
    const catalog = catalogOf(items)
    const agent = this.store.get(conversationId)?.agent
    if (catalog && agent) this.catalogs.set(agent, Promise.resolve(catalog))
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

  // `ref` names the message, for a sender that must not send it twice (see ChatHost.send).
  async send(id: string, text: string, imageIds: readonly string[] = [], queue = false, steer = false, ref?: string): Promise<void> {
    this.get(id)
    const note = this.switchNote(id)
    await this.chats.send(id, note ? `${note}\n\n${text}` : text, await this.chatImages(imageIds), queue, steer, ref)
    if (note) this.store.setSwitchedBranches(id, {})
  }

  // Whether a message with this ref went to the agent in a chat stage still open at `since` or later.
  sentRef(id: string, ref: string, since: number): boolean {
    const conversation = this.get(id)
    return this.store.stages(id)
      .filter((stage) => stage.mode === 'chat' && (stage.endedAt === null || stage.endedAt >= since))
      .some((stage) => this.chats.items(this.chatStage(conversation, stage)).some((item) => item.id === `u:${ref}`))
  }

  // One item as the stage holds it now, for whoever has news about it; null once it is gone.
  chatItem(id: string, stageId: string, itemId: string): ChatItem | null {
    return this.stageChatItems(id, stageId).find((item) => item.id === itemId) ?? null
  }

  // A chat stage's items, live or rebuilt from its log; none once the stage is gone.
  stageChatItems(id: string, stageId: string): ChatItem[] {
    const conversation = this.store.get(id)
    const stage = conversation ? this.store.stages(id).find((each) => each.id === stageId) : undefined
    return conversation && stage?.mode === 'chat' ? this.chats.items(this.chatStage(conversation, stage)) : []
  }

  // Who ran a chat stage, for what, and on which model as its state item last said; null once gone.
  stageFacts(id: string, stageId: string): { taskId: string | null; agent: AgentKind; model: string | null } | null {
    const conversation = this.store.get(id)
    const stage = conversation ? this.store.stages(id).find((each) => each.id === stageId) : undefined
    if (!conversation || !stage) return null
    const state = this.stageChatItems(id, stageId).findLast((item) => item.kind === 'state')
    return { taskId: conversation.taskId ?? null, agent: stage.agent, model: state?.kind === 'state' ? state.model : null }
  }

  // Every chat stage of every conversation, task chats included, oldest first.
  chatStageRefs(): ChatStageRef[] {
    return this.store.list().flatMap((conversation) => this.store.stages(conversation.id)
      .filter((stage) => stage.mode === 'chat')
      .map((stage) => ({ conversationId: conversation.id, taskId: conversation.taskId ?? null, stageId: stage.id, agent: stage.agent, ended: stage.endedAt !== null })))
  }

  // Each image once, checked to be in the store before the agent is asked to look at it.
  private async chatImages(ids: readonly string[]): Promise<ChatImage[]> {
    const images: ChatImage[] = []
    for (const id of new Set(ids)) {
      const info = await this.attachments.info(id)
      if (!info) throw new Rejection('attachment-not-found', `no image ${id}`)
      images.push({ id, width: info.width, height: info.height })
    }
    return images
  }

  cancelQueued(id: string, ref?: string): void {
    this.get(id)
    this.chats.cancelQueued(id, ref)
  }

  async sendQueued(id: string, ref?: string, now = false): Promise<void> {
    this.get(id)
    await this.chats.sendQueued(id, ref, now)
  }

  // Asks the user, in the running chat, whether the browser may open a site; the card stays
  // until they answer, the agent leaves, or the turn is interrupted.
  askHost(id: string, host: string, url: string): Promise<ChatDecision> {
    const requestId = this.chats.ask(id, { kind: 'browser-host', host, url })
    return new Promise((resolve, reject) => this.asks.set(requestId, { resolve, reject }))
  }

  // A question of Kando's answered as cancelled (the agent went, the stage was replayed) has
  // nobody left to tell; its waiter learns so here.
  private settleAsks(items: readonly ChatItem[]): void {
    for (const item of items) {
      if (item.kind !== 'approval' || item.resolution !== 'cancelled' || !isKandoRequest(item.requestId)) continue
      this.asks.get(item.requestId)?.reject(new Rejection('chat-request-gone', 'the question was withdrawn'))
      this.asks.delete(item.requestId)
    }
  }

  async respond(id: string, requestId: string, answer: ChatAnswer): Promise<void> {
    const conversation = this.get(id)
    if (isKandoRequest(requestId)) {
      const resolution = answer.decision === 'allow' ? 'allowed' : answer.decision === 'allowForSession' ? 'allowedForSession' : 'denied'
      this.chats.answer(id, requestId, resolution, answer.message)
      this.asks.get(requestId)?.resolve(answer.decision)
      this.asks.delete(requestId)
      return
    }
    const stage = this.store.activeStage(id)
    const item = conversation.taskId && stage
      ? this.chats.items(this.chatStage(conversation, stage)).find((each) => each.kind === 'approval' && each.requestId === requestId)
      : undefined
    await this.chats.respond(id, requestId, answer)
    if (conversation.taskId && stage && item?.kind === 'approval' && isPlanApproval(item) && item.detail && answer.decision !== 'deny') {
      this.emit({ type: 'planApproved', taskId: conversation.taskId, plan: { markdown: item.detail, agent: stage.agent, stageId: stage.id, requestId } })
    }
  }

  async interrupt(id: string): Promise<void> {
    this.get(id)
    this.chats.cancelAsks(id)
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
    this.free(id)
    await this.remove(id)
  }

  // A task's chat goes with its task; the worktrees it worked in stay.
  async deleteForTask(taskId: string): Promise<void> {
    const conversation = this.store.byTask(taskId)
    if (conversation) await this.remove(conversation.id)
  }

  // Lets a task's agent go, as a task given up or closed no longer needs it.
  async stopForTask(taskId: string): Promise<void> {
    const conversation = this.store.byTask(taskId)
    if (conversation?.sessionId) await this.stop(conversation.id)
  }

  private async remove(id: string): Promise<void> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (current.sessionId) await this.stop(id)
    const directory = path.join(this.sessionsRoot, id)
    await rm(path.join(directory, 'terminal.log'), { force: true })
    await rm(path.join(directory, 'handoffs'), { recursive: true, force: true })
    await rm(path.join(directory, 'stages'), { recursive: true, force: true })
    // The folder goes too, unless it still holds the workspace Kando made, which stays.
    await rmdir(directory).catch(() => {})
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
    if (stage.mode === 'tui') this.tuiWorking.set(conversation.id, message.role === 'user' || !message.complete)
    if (message.role === 'assistant' && message.complete) this.store.completePendingUsers(stage.id)
    if (message.role === 'user' && !conversation.titleLocked && conversation.title === '新会话') {
      // The user's own words name it, not Kando's note of a branch switch before them.
      const first = text.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' ')).find((line) => line && !line.startsWith(SWITCH_NOTE))
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
      this.tuiWorking.delete(current.id)
      const stage = this.store.activeStage(current.id)
      if (stage?.sessionId === sessionId) this.store.endStage(stage.id, stopped ? null : exitCode)
      this.transcript.marker(current.id, stopped ? '会话已停止' : `agent 已退出，code ${exitCode}`)
      this.changed(this.store.update(current.id, { sessionId: null }))
    }
    this.exitWaiters.get(sessionId)?.()
  }

  noteInput(sessionId: string): void {
    const conversation = this.store.bySession(sessionId)
    if (conversation && conversation.mode === 'tui' && this.tuiWorking.get(conversation.id) !== true) {
      this.tuiWorking.set(conversation.id, true)
      this.changed(conversation)
    }
  }

  workingCount(): number {
    return this.store.list().reduce((count, conversation) => {
      if (!conversation.sessionId) return count
      if (conversation.mode === 'chat') return count + (this.chats.activity(conversation.id) === 'running' ? 1 : 0)
      return count + (this.tuiWorking.get(conversation.id) ?? true ? 1 : 0)
    }, 0)
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
          // A question left open across a restart has no browser navigation waiting on it now.
          if (!info.exited) this.chats.cancelAsks(conversation.id)
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
    // A suggestion is for the idle composer; one the settings turned off since is not shown.
    const suggestion = turn === 'idle' && this.promptSuggestions ? this.chats.suggestion(conversation.id) : null
    return { ...conversation, chat: turn ? { turn, ...(suggestion ? { suggestion } : {}) } : null, chatOptions }
  }

  private changed(value: Conversation): Conversation {
    const decorated = this.withChat(value)
    this.emit({ type: 'changed', conversation: decorated })
    return decorated
  }
}
