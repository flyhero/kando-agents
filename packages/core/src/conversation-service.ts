import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkEditAdditionalProjects, checkSwitchBranch, isPlanApproval, MAX_TASK_REPOS, type AgentKind, type ChatCatalog, type ChatImage, type ChatItem, type ChatOption, type ChatSettings, type CommitPushResult, type CommitResult, type PushResult, type Conversation, type ConversationMessage, type ConversationSearchHit, type ConversationStage, type FileDiff, type FolderChanges, type ProjectBranches, type ProjectHead, type ChatDecision, type UnattendedMode, isKandoRequest } from '@kando/protocol'
import type { DaemonEvent, SessionInfo } from '@kando/protocol/node'
import type { TaskLaunchOptions } from '@kando/protocol'
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
import { CURSOR_MODES } from './cursor-acp'
import { cursorCatalog, requireCursorCli } from './cursor-cli'
import { cursorMcpReadyFile, cursorMcpServer, prepareCursorMcp, waitForCursorMcp } from './cursor-mcp'
import type { McpServer } from './agent-command'
import { chatCommand, handoffPrompt, handoffPromptPath } from './conversation-command'
import { searchSnippet } from './conversation-search'
import { buildHandoff } from './conversation-handoff'
import { SCHEDULED_GO_TEXT, UNATTENDED_NOTE } from './agent-prompt'
import { createProjectBranch, projectBranches, switchProjectBranch } from './project-branches'
import { resolveStart } from './task-start'
import { commitAll, commitAndPush, pushBranch } from './project-commit'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import type { UsageReport } from './usage-source'
import { normalizeRepoPath, prepareConversationWorktrees, projectHead } from './workspace'
import { DEFAULT_AGENT_CONCURRENCY } from './chat-settings'
import { WireLog } from './wire-log'

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
export type TaskChatLaunch = TaskLaunchOptions & {
  cwd: string
  extraDirs: readonly string[]
  planOnly: boolean
  session: 'new' | 'resume'
  // Files the agent may read without asking, such as the task's images.
  readable?: readonly string[]
  allowBypass?: boolean
  // What the user adds for the next agent when the task's agent changes on the way.
  handoffNote?: string
}

// What a stage's start takes beyond the agent: see TaskChatLaunch; moved says the agent works
// somewhere else than its last stage did.
type StageLaunch = { fresh?: boolean; moved?: boolean; planOnly?: boolean; readable?: readonly string[]; fork?: ForkPoint }
// The provider session another conversation's stage ran, taken over through the turn `at` names;
// neither null means a session the agent can fork, else the fork starts afresh.
type ForkPoint = { providerSessionId: string | null; at: string | null }

// A chat page stops adding older stages once it holds this many items.
const CHAT_PAGE_ITEMS = 1000
const STOP_GRACE_MS = 5000
const KILL_GRACE_MS = 2000
const CURSOR_CANCEL_GRACE_MS = 2000
const CURSOR_TERM_GRACE_MS = 2000
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
  // Core's chat settings say; main hands them over before any stage starts.
  private promptSuggestions = false
  private readonly launching = new Map<string, AgentKind>()
  private readonly gitSending = new Map<string, number>()
  private gitPreparation: (<T>(dirs: readonly string[], run: () => Promise<T>) => Promise<T>) | null = null
  setGitPreparation(prepare: <T>(dirs: readonly string[], run: () => Promise<T>) => Promise<T>): void { this.gitPreparation = prepare }
  private gitGuard: ((dirs: readonly string[]) => Promise<void>) | null = null

  isGitPending(id: string): boolean { return this.launching.has(id) || this.gitSending.has(id) }

  setGitGuard(guard: (dirs: readonly string[]) => Promise<void>): void { this.gitGuard = guard }

  async recordGitChange(id: string, project: string, branch: string, resetStart: boolean): Promise<void> {
    const conversation = this.get(id)
    if (resetStart && !conversation.taskId) {
      const head = await folderHead(project)
      if (head) this.store.setProjectStart(id, project, head)
    }
    this.store.setSwitchedBranches(id, { ...this.store.switchedBranches(id), [project]: branch })
    this.changed(this.get(id))
  }
  private maxConcurrentAgents = 20
  private agentConcurrency: Partial<Record<AgentKind, number>> = {}
  private capacityReleased: (() => void) | null = null
  private readonly catalogs = new Map<AgentKind, Promise<ChatCatalog | null>>()
  private readonly chats: ChatHost
  // Sessions being stopped on purpose: their exit reads as a stop, not a crash.
  private readonly stopping = new Set<string>()
  private readonly exitWaiters = new Map<string, () => void>()
  private readonly cursorStops = new Map<string, Promise<void>>()
  private readonly cursorActions = new Map<string, Promise<void>>()
  // Kando's own questions waiting on the user, by request id.
  private readonly asks = new Map<string, { resolve: (decision: ChatDecision) => void; reject: (error: Error) => void }>()

  constructor(
    private readonly store: ConversationStore,
    private readonly daemon: SessionHost,
    private readonly sessionsRoot: string,
    private readonly emit: (event: ConversationEvent) => void,
    private readonly projects: ProjectRegistry,
    private readonly attachments: AttachmentStore,
    // Kando's MCP server for a conversation's agent, acting for that conversation; null leaves the
    // agent without Kando's tools.
    private readonly mcp: ((conversationId: string) => McpServer) | null = null,
    // Where a conversation started in worktrees lays them out; null offers none.
    private readonly worktreesRoot: string | null = null,
    // Where chat stages' raw traffic goes while the user has it on; null keeps none.
    private readonly wire: WireLog | null = null
  ) {
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
      usage: (stage, report) => this.emit({ type: 'usage', agent: stage.agent, report }),
      cursorStalled: (_conversationId, sessionId) => {
        this.stopping.add(sessionId)
        // ChatHost dispatches session/cancel immediately after this callback; begin its grace
        // period in the following microtask so the cancellation is always first.
        queueMicrotask(() => { void this.stopCursorAfterCancel(sessionId) })
      }
    }, Date.now, wire)
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

  setCapacity(settings: Pick<ChatSettings, 'maxConcurrentAgents' | 'agentConcurrency'>, released: () => void): void {
    const hadCapacity = this.capacityReleased !== null
    this.maxConcurrentAgents = settings.maxConcurrentAgents ?? 20
    this.agentConcurrency = settings.agentConcurrency ?? {}
    this.capacityReleased = released
    if (hadCapacity) released()
  }

  // Count sessions, not turns: an agent awaiting approval still owns a process and a slot. A
  // launch in progress reserves its slot until it either attaches a session or fails.
  capacityAvailable(agent: AgentKind, conversationId?: string | null): boolean {
    const existing = conversationId ? this.store.get(conversationId) : null
    if (existing?.sessionId && existing.agent === agent) return true
    const active = new Map(this.store.list().filter((conversation) => conversation.sessionId !== null)
      .map((conversation) => [conversation.id, conversation.agent]))
    // A handoff may replace this conversation's old process before starting the new agent.
    if (existing?.sessionId && conversationId) active.delete(conversationId)
    for (const [id, kind] of this.launching) if (!active.has(id)) active.set(id, kind)
    return active.size < this.maxConcurrentAgents &&
      [...active.values()].filter((kind) => kind === agent).length < (this.agentConcurrency[agent] ?? DEFAULT_AGENT_CONCURRENCY)
  }

  // Task summaries are opt-in; older clients expect only free conversations.
  list(includeTasks = false): Conversation[] {
    return this.store.list().filter((conversation) => includeTasks || !conversation.taskId).map((conversation) => this.withChat(conversation))
  }
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
    const stages = this.store.stages(id).filter((stage) => stage.startedAt <= to && (stage.endedAt === null || stage.endedAt >= from))
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
  // A project's branches before any conversation has it: for a new one to start on.
  async projectBranchOptions(project: string): Promise<ProjectBranches> {
    const live = this.store.list().filter((other) => other.sessionId !== null)
    return {
      path: project,
      ...await projectBranches(project),
      sharedWith: live.filter((other) => other.projectPaths.includes(project)).map((other) => other.title)
    }
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
    return commitAndPush(this.gitProject(id, project), message)
  }

  async commit(id: string, project: string, message: string): Promise<CommitResult> {
    return commitAll(this.gitProject(id, project), message)
  }

  async push(id: string, project: string): Promise<PushResult> {
    return pushBranch(this.gitProject(id, project))
  }

  // A project of the conversation git may write to: only while no agent works in its folder.
  private gitProject(id: string, project: string): string {
    const conversation = this.get(id)
    const blocker = checkSwitchBranch(conversation)
    if (blocker) throw new Rejection(blocker)
    if (!conversation.projectPaths.includes(project)) throw new Rejection('repo-not-found', `${project} is not one of the conversation's projects`)
    return project
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

  // routine: the routine whose run opens it, which also names it for good; id: the run's own,
  // so a start tried again finds the conversation it already made. start.worktree: it works in a
  // worktree of each project rather than in the project itself.
  async create(
    agent: AgentKind,
    projectPaths: readonly string[],
    allowBypass?: boolean,
    start: { permissionMode?: string; model?: string; effort?: string; worktree?: boolean; branch?: string; deferStart?: boolean } = {},
    routine: { id: string; title: string } | null = null,
    id: string = randomUUID()
  ): Promise<Conversation> {
    if (projectPaths.length > MAX_TASK_REPOS) throw new Rejection('too-many-projects')
    const { permissionMode, model, effort, worktree = false, branch } = start
    const worktreesRoot = worktree ? this.worktreesRoot : null
    if (worktree && (!worktreesRoot || projectPaths.length === 0)) throw new Rejection('missing-repo', 'a worktree needs a project to lay out')
    if (!this.capacityAvailable(agent)) throw new Rejection('agent-capacity')
    await this.validateStartOptions(agent, { permissionMode, model, effort })
    const resolved = await resolveProjects(projectPaths)
    const { picked } = resolved
    const primary = resolved.projects[0]
    if (branch && !primary) throw new Rejection('missing-repo', 'a branch needs a project')
    // The primary's branch: in a worktree, where its branch starts (a remote one fetched first);
    // in the project itself, switched to before anything else, so a refusal makes nothing.
    const prepare = async () => {
      const primaryStart = branch && primary && worktreesRoot ? (await resolveStart(primary, branch, null, Date.now())).commit : undefined
      if (branch && primary && !worktreesRoot) await switchProjectBranch(primary, branch)
      return worktreesRoot
        ? await Promise.all((await prepareConversationWorktrees(id, resolved.projects, worktreesRoot, primaryStart)).map((dir) => realpath(dir)))
        : resolved.projects
    }
    const projects = this.gitPreparation && (branch || worktree)
      ? await this.gitPreparation(resolved.projects, prepare) : await prepare()
    let workspace: string
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
    const created = this.store.create(agent, workspace, projects, id, starts, null, routine)
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (permissionMode) this.store.setChatOptions(id, { permissionMode })
    if (model || effort) this.store.setChatOptions(id, { [agent]: { model, effort } })
    // The paths as picked, not resolved: the same strings a task stores for them.
    this.projects.remember(picked)
    if (start.deferStart) return this.changed(this.get(id))
    this.changed(created)
    return this.start(id, agent, '', false)
  }

  // Everything but the primary changes (checkEditAdditionalProjects). The agent is given its
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
    return live ? this.start(id, conversation.agent, '', false) : this.changed(this.get(id))
  }

  // A task's chat is driven from its task, which checks what the task may do first.
  private free(id: string): Conversation {
    const conversation = this.get(id)
    if (conversation.taskId) throw new Rejection('task-conversation', 'this conversation runs a task; go on from the task')
    return conversation
  }

  // Validate before preparing a workspace or replacing a task's existing stage.
  async validateStartOptions(agent: AgentKind, options: { permissionMode?: string; model?: string | null; effort?: string | null }): Promise<void> {
    const { permissionMode, model, effort } = options
    if (permissionMode && !(permissionMode in (agent === 'claude' ? CLAUDE_MODE_NAMES : agent === 'cursor' ? CURSOR_MODES : CODEX_MODES))) {
      throw new Rejection('chat-option-invalid', `${agent} has no permission mode ${permissionMode}`)
    }
    if (model || effort) {
      const models = (await this.chatCatalog(agent))?.models ?? []
      const picked = models.find((each) => each.id === (model ?? models.find((one) => one.isDefault)?.id))
      if (model && !picked) throw new Rejection('chat-option-invalid', `${agent} lists no model ${model}`)
      if (effort && !picked?.efforts.includes(effort)) throw new Rejection('chat-option-invalid', `the model takes no effort ${effort}`)
    }
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
    // Going on with another agent than the chat had, it is handed what was said, as a handoff is.
    const switched = launch.session === 'resume' && conversation.agent !== task.agent
    const same = !regrouped && !switched && (conversation.planOnly ?? false) === launch.planOnly
    if (live && launch.session === 'resume' && same) return this.withChat(conversation)
    if (conversation.sessionId && !this.chats.idle(id)) throw new Rejection('chat-busy', 'the agent is still working')
    if (conversation.sessionId) await this.stop(id)
    if (regrouped) this.store.moveWorkspace(id, cwd, projectPaths)
    if (conversation.title !== task.title) this.store.update(id, { title: task.title })
    if (launch.allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass: launch.allowBypass })
    // A stage of its own plans first; one going on keeps the mode it was left in.
    if (launch.session === 'new') this.store.setChatOptions(id, { permissionMode: launch.permissionMode ?? 'plan' })
    if (launch.model !== undefined || launch.effort !== undefined) {
      const previous = this.store.chatOptions(id)[task.agent] ?? {}
      this.store.setChatOptions(id, { [task.agent]: {
        model: launch.model === undefined ? previous.model : launch.model ?? undefined,
        effort: launch.effort === undefined
          ? (launch.model !== undefined && launch.model !== previous.model ? undefined : previous.effort)
          : launch.effort ?? undefined
      } })
    }
    return this.start(id, task.agent, launch.handoffNote ?? '', switched, {
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

  // The conversations a deleted routine opened become the user's like any other: back in the list.
  clearRoutine(routineId: string): void {
    for (const conversation of this.store.clearRoutine(routineId)) this.changed(conversation)
  }

  // A task's conversation is listed under its task, so only a free one is pinned.
  setPinned(id: string, pinned: boolean): Conversation {
    const current = this.free(id)
    if ((current.pinnedAt != null) === pinned) return current
    return this.changed(this.store.setPinned(id, pinned))
  }

  // Readies the agent for a message: one already up stays as it is.
  async continue(id: string, allowBypass?: boolean): Promise<Conversation> {
    const current = this.free(id)
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && this.chats.activity(id) !== null) return current
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (current.sessionId) await this.stop(id)
    return this.start(id, current.agent, '', false)
  }

  async handoff(id: string, agent: AgentKind, note: string, stopRunning: boolean, allowBypass?: boolean): Promise<Conversation> {
    const current = this.free(id)
    if (agent === current.agent) throw new Rejection('conversation-same-agent')
    if (allowBypass !== undefined) this.store.setChatOptions(id, { allowBypass })
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (current.sessionId && !stopRunning && !this.chats.idle(id)) throw new Rejection('conversation-running')
    if (!this.capacityAvailable(agent, id)) throw new Rejection('agent-capacity')
    if (current.sessionId) await this.stop(id)
    return this.start(id, agent, note, true)
  }

  // A new conversation holding this one's chat up to a message, for the same agent in the same
  // projects: through the turn an agent's message belongs to, or up to (not including) a user
  // message, which the client puts back in the input. The chat logs are copied and cut, so the new
  // conversation reads as the old one did at that point; the agent's own session is forked at
  // the same turn where it can be, so it remembers just that much.
  async fork(sourceId: string, stageId: string, itemId: string): Promise<Conversation> {
    const source = this.free(sourceId)
    const stages = this.store.stages(sourceId)
    const index = stages.findIndex((stage) => stage.id === stageId)
    if (index < 0) throw new Rejection('stage-not-found', `no chat stage ${stageId}`)
    const cutStage = stages[index]!
    const items = this.chats.items(this.chatStage(source, cutStage))
    const position = items.findIndex((item) => item.id === itemId)
    if (position < 0) throw new Rejection('chat-item-not-found', `no chat item ${itemId}`)
    const picked = items[position]!
    // What of the cut stage goes along, and where the agent's own session is cut.
    const turnAt = (from: number) => items.slice(from).find((item): item is Extract<ChatItem, { kind: 'turn' }> => item.kind === 'turn')
    const lastTurnBefore = (end: number) => items.slice(0, end).reverse().find((item): item is Extract<ChatItem, { kind: 'turn' }> => item.kind === 'turn')
    let kept: ChatItem[]
    let turn: Extract<ChatItem, { kind: 'turn' }> | undefined
    const before = picked.kind === 'user' ? picked : null
    if (before) {
      kept = items.slice(0, position)
      turn = lastTurnBefore(position)
    } else {
      const closing = turnAt(position)
      if (!closing) throw new Rejection('fork-turn-running', 'this turn has not ended yet')
      kept = items.slice(0, items.indexOf(closing) + 1)
      turn = closing
    }
    // The last turn in an earlier stage, when the cut stage has none before the point.
    const earlier = turn ?? stages.slice(0, index).reverse().map((stage) => this.chats.items(this.chatStage(source, stage)).reverse().find((item) => item.kind === 'turn')).find(Boolean)
    const sessionStage = turn ? cutStage : stages.slice(0, index).reverse().find((stage) => this.chats.items(this.chatStage(source, stage)).some((item) => item.kind === 'turn'))
    // The agent whose session is forked goes on; one that has never spoken here is the source's.
    const agent = sessionStage?.agent ?? source.agent
    if (!this.capacityAvailable(agent)) throw new Rejection('agent-capacity')
    const fork: ForkPoint = { providerSessionId: sessionStage?.providerSessionId ?? null, at: earlier?.kind === 'turn' ? earlier.providerRef ?? null : null }
    // A fork of a Claude session must run in the folder the session ran in: the same projects, or
    // the source's own managed workspace, shared from now on (remove() leaves a workspace in place).
    const id = randomUUID()
    const created = this.store.create(agent, source.workspacePath, source.projectPaths, id, this.store.projectStarts(sourceId))
    this.store.setForkedFrom(id, sourceId)
    this.store.setChatOptions(id, this.store.chatOptions(sourceId))
    this.store.update(id, { title: `${source.title} · 分支`, titleLocked: true })
    // The chat so far: every earlier stage whole, the cut stage up to the point, each as a stage
    // of the new conversation that has ended, with the messages those turns recorded.
    for (const stage of stages.slice(0, index + 1)) {
      const copyId = randomUUID()
      this.store.startStage(id, stage.agent, null, 0, copyId, stage.planOnly ?? false)
      const { records } = ChatLog.of(this.sessionsRoot, sourceId, stage.id).read()
      const last = stage.id === cutStage.id ? kept.at(-1) : undefined
      const cutAt = stage.id === cutStage.id ? (before ? before.at : last?.at ?? 0) : Infinity
      const copied = records.filter((record) => (before && stage.id === cutStage.id ? record.at < cutAt : record.at <= cutAt))
      const endedAt = copied.at(-1)?.at ?? this.store.stage(copyId)!.startedAt
      ChatLog.of(this.sessionsRoot, id, copyId).append([...copied, { dir: 'exit', at: endedAt, code: null, stderr: '' }])
      const refs = new Set((stage.id === cutStage.id ? kept : this.chats.items(this.chatStage(source, stage)))
        .flatMap((item) => (item.kind === 'user' && item.id.startsWith('u:') ? [item.id.slice(2)] : [])))
      for (const message of this.store.messages(sourceId)) {
        if (message.stageId !== stage.id) continue
        const ref = /^chat:(.+):(user|assistant)$/.exec(message.eventKey)?.[1]
        if (ref === undefined || !refs.has(ref)) continue
        this.store.addMessage({ conversationId: id, stageId: copyId, role: message.role, agent: message.agent, text: message.text, eventKey: message.eventKey, complete: true })
      }
      this.store.endStage(copyId, null)
    }
    this.changed(created)
    await this.start(id, agent, '', false, { fork })
    return this.withChat(this.store.get(id)!)
  }

  private async start(id: string, agent: AgentKind, note: string, handoff: boolean, launch: StageLaunch = {}): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    if (!this.capacityAvailable(agent)) throw new Rejection('agent-capacity', 'Agent 运行数量已达到上限，请等待其他会话结束，或预约稍后执行')
    this.launching.set(id, agent)
    try {
      const current = this.get(id)
      await this.gitGuard?.(current.projectPaths)
      this.changed(current)
      if (current.sessionId) throw new Rejection('conversation-running')
      if (launch.fork) return { ...await this.startFork(current, agent, launch.fork), starting: false }
      const previous = launch.fresh ? null : this.store.latestStage(id, agent)
      // Kando picks a Claude session id before launch, so a run that died before its first prompt
      // left an id Claude never saved. Only a session that recorded messages can be resumed, and
      // only from the folder it ran in: moved elsewhere, Claude starts afresh from a handoff.
      const resumable = !(launch.moved && (agent === 'claude' || agent === 'cursor'))
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
      const stage = this.store.startStage(id, agent, providerSessionId, this.store.maxSequence(id), stageId, launch.planOnly ?? false)
      return { ...await this.startChat(current, stage, saved !== null, handoffPath, launch.readable ?? []), starting: false }
    } finally {
      this.launching.delete(id)
      const current = this.store.get(id)
      if (current) this.changed(current)
      this.capacityReleased?.()
    }
  }

  // The first stage of a fork: the source's session taken over through the fork point, where the
  // agent can (Claude's session from the same folder, Codex's thread), else a fresh start. The chat
  // it continues is already copied, so no handoff file is written.
  private async startFork(current: Conversation, agent: AgentKind, fork: ForkPoint): Promise<Conversation> {
    const native = agent !== 'cursor' && fork.providerSessionId !== null && fork.at !== null
    const providerSessionId = native ? fork.providerSessionId : agent === 'claude' ? randomUUID() : null
    // Without a session to fork, the copied chat reaches the agent the way a handoff does.
    let handoffPath: string | null = null
    const messages = native ? [] : this.store.messages(current.id)
    if (messages.length > 0) {
      const directory = path.join(this.sessionsRoot, current.id, 'handoffs')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      handoffPath = path.join(directory, `${randomUUID()}.md`)
      await writeFile(handoffPath, buildHandoff(current, messages, '', agent, agent), { mode: 0o600 })
    }
    const stage = this.store.startStage(current.id, agent, providerSessionId, this.store.maxSequence(current.id), randomUUID(), false)
    return this.startChat(current, stage, native, handoffPath, [], native ? fork.at : null)
  }

  // Runs the stage's agent over stdio, driven by the chat host, and waits until it can take a message.
  private async startChat(
    current: Conversation,
    stage: ConversationStage,
    resume: boolean,
    handoffPath: string | null,
    readable: readonly string[],
    forkAt: string | null = null
  ): Promise<Conversation> {
    const { id } = current
    const { agent } = stage
    const { options } = this.chatStage(current, stage, forkAt)
    const cursorReady = agent === 'cursor' ? cursorMcpReadyFile(this.sessionsRoot, id, stage.id) : null
    const command = chatCommand(agent, stage.providerSessionId, resume, handoffPath, options.extraDirs, {
      preferred: options.preferred,
      allowBypass: options.allowBypass,
      planOnly: options.planOnly ? { dirs: [options.cwd, ...options.extraDirs] } : undefined,
      readable,
      forkAt,
      ...(this.mcp ? { mcp: this.mcp(id) } : {})
    })
    let sessionId: string
    try {
      if (cursorReady) {
        command.command = await requireCursorCli()
        if (!options.mcp) throw new Rejection('cursor-mcp-unavailable', 'Cursor 需要 Kando MCP 配置')
        await prepareCursorMcp(cursorReady)
      }
      this.wire?.record(id, stage.id, [{ dir: 'spawn', text: JSON.stringify({ command: command.command, args: command.args, cwd: current.workspacePath }) }])
      const spawned = await this.daemon.request('spawnPipe', { command: command.command, args: command.args, cwd: current.workspacePath, env: {} })
      sessionId = spawned.sessionId
      if (cursorReady) {
        this.wire?.record(id, stage.id, [{
          dir: 'note',
          text: JSON.stringify({ event: 'cursor-lifecycle', phase: 'process-spawned', sessionId })
        }])
      }
    } catch (error) {
      this.store.deleteStage(stage.id)
      throw error instanceof Rejection && error.reason === 'unknown-method'
        ? new Rejection('daemon-outdated', 'the running daemon predates chat mode; restart it')
        : error
    }
    this.store.attachStage(stage.id, sessionId)
    this.changed(this.store.update(id, { agent, sessionId }))
    try {
      await this.chats.open(this.chatStage(current, stage, forkAt), sessionId, 0, true)
      if (cursorReady) await waitForCursorMcp(cursorReady)
      if (handoffPath) await this.chats.send(id, handoffPrompt(handoffPath))
    } catch (error) {
      // A stage that never started leaves nothing to resume, so it goes, log and all.
      this.chats.forget(sessionId, stage.id)
      await this.daemon.request('kill', { sessionId, force: true }).catch(() => {})
      this.store.deleteStage(stage.id)
      await rm(ChatLog.of(this.sessionsRoot, id, stage.id).file, { force: true })
      this.changed(this.store.update(id, { sessionId: null }))
      throw error
    }
    // Announced again now that the agent can take a message: clients learn it is idle.
    return this.changed(this.store.touch(id))
  }

  // A picture a tool returned in its bytes (an MCP screenshot), kept so the chat can show it after
  // the log has left the bytes out. One the store refuses (too large, not an image) stays a placeholder.
  private keepImage(data: string): ChatImage | null {
    try {
      const { id, width, height } = this.attachments.putSync(Buffer.from(data, 'base64'))
      return { id, width, height }
    } catch {
      return null
    }
  }

  // forkAt: only while the stage is being opened as a fork; a stage taken back later resumes the
  // session the fork made, which the stage then holds.
  private chatStage(conversation: Conversation, stage: ConversationStage, forkAt: string | null = null): ChatStage {
    const chosen = this.store.chatOptions(conversation.id)
    const mcp = this.mcp?.(conversation.id)
    let permissionMode = chosen.permissionMode
    if (stage.agent === 'cursor' && (!permissionMode || !(permissionMode in CURSOR_MODES))) permissionMode = 'ask'
    return {
      conversationId: conversation.id,
      stageId: stage.id,
      agent: stage.agent,
      ended: stage.endedAt != null,
      options: {
        cwd: conversation.workspacePath,
        ...(mcp ? { mcp: stage.agent === 'cursor' ? cursorMcpServer(mcp, cursorMcpReadyFile(this.sessionsRoot, conversation.id, stage.id), stage.planOnly ?? false) : mcp } : {}),
        extraDirs: conversation.projectPaths.slice(1),
        resume: stage.providerSessionId,
        fork: forkAt,
        // Read off the stage, so a stage taken back after a restart still only plans.
        planOnly: stage.planOnly ?? false,
        allowBypass: !stage.planOnly && (chosen.allowBypass ?? false),
        promptSuggestions: this.promptSuggestions,
        preferred: { permissionMode, ...chosen[stage.agent] },
        keepImage: (data) => this.keepImage(data)
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
    if (agent === 'cursor') {
      const stage = this.store.activeStage(id)
      const state = stage ? this.chats.items(this.chatStage(conversation, stage)).findLast((item) => item.kind === 'state') : null
      if (state?.kind === 'state') this.store.setChatOptions(id, { cursor: { model: state.model ?? undefined, effort: state.effort ?? undefined } })
      return
    }
    const chosen = this.store.chatOptions(id)
    this.store.setChatOptions(id, { [agent]: { ...chosen[agent], [option]: value } })
  }

  private chooseForNextStart(conversation: Conversation, option: ChatOption, value: string): void {
    const { id, agent } = conversation
    const stage = this.store.stages(id).at(-1)
    const state = stage?.agent === agent
      ? this.chats.items(this.chatStage(conversation, stage)).findLast((item) => item.kind === 'state')
      : undefined
    if (state?.kind !== 'state') throw new Rejection('chat-option-invalid', `no chat stage of ${agent} to take options from`)
    const chosen = this.store.chatOptions(id)
    const current = chosen[agent] ?? {}
    const model = (name: string | null | undefined) => state.models.find((each) => each.id === name)
    if (option === 'permissionMode') {
      // Bypass is for the start to allow, which asks the user's setting again.
      if ((value !== 'bypass' || agent === 'cursor') && !state.permissionModes.includes(value)) throw new Rejection('chat-option-invalid', `${agent} offers no permission mode ${value}`)
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
    const catalog = found ? Promise.resolve(found) : agent === 'cursor' ? cursorCatalog(this.sessionsRoot).catch(() => null) : probeChatCatalog(
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

  // A retry may resume in a new stage; its ref still names the original message.
  async send(id: string, text: string, imageIds: readonly string[] = [], queue = false, steer = false, ref?: string): Promise<void> {
    const conversation = this.get(id)
    if (conversation.agent === 'cursor') {
      return this.withCursorAction(id, () => this.sendNow(id, text, imageIds, queue, steer, ref))
    }
    return this.sendNow(id, text, imageIds, queue, steer, ref)
  }

  private async sendNow(id: string, text: string, imageIds: readonly string[], queue: boolean, steer: boolean, ref?: string): Promise<void> {
    this.gitSending.set(id, (this.gitSending.get(id) ?? 0) + 1)
    try {
      await this.gitGuard?.(this.get(id).projectPaths)
      if (ref && this.sentRef(id, ref, 0)) return
      const note = this.switchNote(id)
      await this.chats.send(id, note ? `${note}\n\n${text}` : text, await this.chatImages(imageIds), queue, steer, ref)
      if (note) this.store.setSwitchedBranches(id, {})
    } finally { const pending = (this.gitSending.get(id) ?? 1) - 1; if (pending) this.gitSending.set(id, pending); else this.gitSending.delete(id) }
  }

  private async withCursorAction<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.cursorActions.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(action)
    const tail = result.then(() => {}, () => {})
    this.cursorActions.set(id, tail)
    try {
      return await result
    } finally {
      if (this.cursorActions.get(id) === tail) this.cursorActions.delete(id)
    }
  }

  // Whether a message with this ref went to the agent in a chat stage still open at `since` or later.
  // Goes on for a scheduled run, with nobody there to answer: a plan waiting for approval is
  // approved, or the agent is readied in the unattended mode (`ready` starts it: a task's chat goes
  // through its task) and told to go ahead. A turn still running has the message wait behind it.
  // images go with the text; a message of pictures alone is sent as it is, not as the go-ahead.
  async runScheduled(id: string, text: string, images: readonly string[], mode: UnattendedMode, ready: () => Promise<unknown>, ref: string): Promise<void> {
    const conversation = this.get(id)
    if (conversation.agent === 'cursor') throw new Rejection('cursor-unattended-unsupported', 'Cursor 暂不支持无人值守运行')
    const plan = this.waitingPlan(conversation)
    if (plan) {
      await this.chats.respond(id, plan.requestId, { decision: 'allowForSession' })
      // Edits are what approving lets through; bypass only where the stage was started allowing it.
      if (mode === 'bypass') await this.chats.setOption(id, 'permissionMode', mode).catch(() => {})
      if (text || images.length) await this.send(id, `${UNATTENDED_NOTE}\n\n${text}`.trim(), images, true, false, ref)
      return
    }
    const live = this.chats.activity(id) !== null
    const switched = live && await this.chats.setOption(id, 'permissionMode', mode).then(() => true, () => false)
    // A stage started without bypass allowed cannot switch to it: an idle one starts again, allowing it.
    if (live && !switched && mode === 'bypass' && this.chats.idle(id) && !conversation.planOnly) await this.stop(id)
    if (this.chats.activity(id) === null) {
      this.store.setChatOptions(id, { permissionMode: mode, ...(mode === 'bypass' ? { allowBypass: true } : {}) })
      await ready()
    }
    await this.send(id, `${UNATTENDED_NOTE}\n\n${text || (images.length ? '' : SCHEDULED_GO_TEXT)}`.trim(), images, !this.chats.idle(id), false, ref)
  }

  // The plan the live stage waits on the user to approve, if any.
  private waitingPlan(conversation: Conversation): { requestId: string } | null {
    const stage = this.chats.activity(conversation.id) === null ? null : this.store.activeStage(conversation.id)
    if (!stage) return null
    const item = this.chats.items(this.chatStage(conversation, stage))
      .findLast((each) => each.kind === 'approval' && isPlanApproval(each) && each.resolution === null)
    return item?.kind === 'approval' ? { requestId: item.requestId } : null
  }

  sentRef(id: string, ref: string, since: number): boolean {
    const conversation = this.get(id)
    return this.store.stages(id)
      .filter((stage) => stage.endedAt === null || stage.endedAt >= since)
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
    return conversation && stage ? this.chats.items(this.chatStage(conversation, stage)) : []
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
    this.gitSending.set(id, (this.gitSending.get(id) ?? 0) + 1)
    try {
      await this.gitGuard?.(this.get(id).projectPaths)
      await this.chats.sendQueued(id, ref, now)
    } finally { const pending = (this.gitSending.get(id) ?? 1) - 1; if (pending) this.gitSending.set(id, pending); else this.gitSending.delete(id) }
  }

  // Asks the user, in the running chat, whether the browser may open a site; the card stays
  // until they answer, the agent leaves, or the turn is interrupted.
  askHost(id: string, host: string, url: string): Promise<ChatDecision> {
    const requestId = this.chats.ask(id, { kind: 'browser-host', host, url })
    return new Promise((resolve, reject) => this.asks.set(requestId, { resolve, reject }))
  }

  // Asks the user, in the running chat, whether a command the agent wants may run in a terminal
  // of its own; the same card, and the same answers, as a site the browser would open.
  askTerminal(id: string, command: string, cwd: string): Promise<ChatDecision> {
    const requestId = this.chats.ask(id, { kind: 'terminal-run', command, cwd })
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
    if (stage?.agent === 'cursor' && answer.decision === 'deny' && answer.message) await this.chats.send(id, answer.message, [], true)
    if (conversation.taskId && stage && item?.kind === 'approval' && isPlanApproval(item) && item.detail && answer.decision !== 'deny') {
      this.emit({ type: 'planApproved', taskId: conversation.taskId, plan: { markdown: item.detail, agent: stage.agent, stageId: stage.id, requestId } })
    }
  }

  async interrupt(id: string): Promise<void> {
    const current = this.get(id)
    this.chats.cancelAsks(id)
    if (current.agent !== 'cursor' || !current.sessionId) {
      await this.chats.interrupt(id)
      return
    }
    // Mark it intentional before writing cancel: Cursor may obey and exit before the daemon's
    // write request itself has resolved.
    this.stopping.add(current.sessionId)
    try {
      await this.chats.interrupt(id)
      await this.stopCursorAfterCancel(current.sessionId)
    } catch (error) {
      this.stopping.delete(current.sessionId)
      throw error
    }
  }

  async retryCursorTurn(id: string, stageId: string, itemId: string): Promise<void> {
    await this.withCursorAction(id, async () => {
      const conversation = this.get(id)
      if (conversation.agent !== 'cursor') throw new Rejection('chat-option-invalid', 'only Cursor turns can reconnect this way')
      const stage = this.store.stages(id).find((candidate) => candidate.id === stageId)
      if (!stage) throw new Rejection('stage-not-found', `no chat stage ${stageId}`)
      const notice = this.chats.items(this.chatStage(conversation, stage)).find((item) => item.id === itemId)
      if (notice?.kind !== 'notice' || notice.action?.kind !== 'retryCursorTurn') {
        throw new Rejection('chat-item-not-found', `no retry action ${itemId}`)
      }
      const user = this.chats.items(this.chatStage(conversation, stage)).find((item) => item.id === notice.action?.userItemId)
      if (user?.kind !== 'user') throw new Rejection('chat-item-not-found', 'the Cursor message to retry is no longer available')

      const active = this.get(id)
      if (active.sessionId) await this.cursorStops.get(active.sessionId)
      const ready = this.get(id)
      if (ready.sessionId && !this.chats.idle(id)) throw new Rejection('chat-busy', 'Cursor is already working on another turn')
      if (ready.sessionId) await this.stop(id)
      await this.start(id, 'cursor', '', false)
      await this.sendNow(id, user.text, user.images.map((image) => image.id), false, false, randomUUID())
      this.chats.updateNotice(this.chatStage(conversation, stage), {
        dir: 'note',
        at: Date.now(),
        id: notice.id,
        level: notice.level,
        text: '已重新连接 Cursor，并重新发送这条消息。',
        action: null
      })
    })
  }

  // The newest chat stages' items, oldest first; `before` pages further back.
  chatPage(id: string, before?: string): { items: ChatItem[]; before: string | null } {
    const conversation = this.get(id)
    const stages = this.store.stages(id)
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

  async stop(id: string): Promise<Conversation> {
    if (this.launching.has(id)) throw new Rejection('conversation-running')
    const current = this.get(id)
    if (!current.sessionId) return current
    await this.stopAgent(current.sessionId)
    if (this.store.get(id)?.sessionId === null) return this.get(id)
    const stage = this.store.activeStage(id)
    if (stage) this.store.endStage(stage.id, null)
    const stopped = this.changed(this.store.update(id, { sessionId: null }))
    this.capacityReleased?.()
    return stopped
  }

  // An agent is gone only once the daemon says so: clearing the session any earlier would let a
  // continue start a second writer on the same Claude session or Codex thread.
  private async stopAgent(sessionId: string): Promise<void> {
    const cursorStop = this.cursorStops.get(sessionId)
    if (cursorStop) return cursorStop
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

  // session/cancel has already been written. Give Cursor two seconds to obey it, then terminate
  // the process group, and force-kill the group only if it survives another two seconds.
  private stopCursorAfterCancel(sessionId: string): Promise<void> {
    const existing = this.cursorStops.get(sessionId)
    if (existing) return existing
    const stopping = this.finishCursorStop(sessionId)
    this.cursorStops.set(sessionId, stopping)
    const clear = () => {
      if (this.cursorStops.get(sessionId) === stopping) this.cursorStops.delete(sessionId)
    }
    void stopping.then(clear, clear)
    return stopping
  }

  private async finishCursorStop(sessionId: string): Promise<void> {
    const exited = new Promise<void>((resolve) => this.exitWaiters.set(sessionId, resolve))
    this.stopping.add(sessionId)
    try {
      if (!this.store.bySession(sessionId) || await settles(exited, CURSOR_CANCEL_GRACE_MS)) return
      await this.daemon.request('kill', { sessionId }).catch(() => {})
      if (!this.store.bySession(sessionId) || await settles(exited, CURSOR_TERM_GRACE_MS)) return
      await this.daemon.request('kill', { sessionId, force: true }).catch(() => {})
      await settles(exited, KILL_GRACE_MS)
    } finally {
      this.exitWaiters.delete(sessionId)
      this.stopping.delete(sessionId)
    }
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
    await rm(path.join(directory, 'handoffs'), { recursive: true, force: true })
    await rm(path.join(directory, 'stages'), { recursive: true, force: true })
    await rm(WireLog.directory(this.sessionsRoot, id), { recursive: true, force: true })
    // The folder goes too, unless it still holds the workspace Kando made, which stays.
    await rmdir(directory).catch(() => {})
    this.store.delete(id)
    this.emit({ type: 'deleted', id })
  }

  // The message itself, then what it says about the rest.
  private recordChatMessage(chat: ChatStage, message: StageMessage): void {
    const conversation = this.store.get(chat.conversationId)
    const stage = this.store.stage(chat.stageId)
    if (!conversation || !stage) return
    const text = message.text.trim()
    if (!text || (message.role === 'user' && this.isHandoffPrompt(conversation.id, text))) return
    const saved = this.store.addMessage({
      conversationId: conversation.id, stageId: stage.id, role: message.role, agent: stage.agent,
      text, eventKey: message.eventKey, complete: message.complete
    })
    if (!saved) return
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

  // Output before the host has opened the stage (core just restarted) is left: open() reads it from
  // the daemon's buffer.
  handleData(event: Extract<DaemonEvent, { event: 'data' }>): void {
    this.chats.handleData(event.sessionId, event.offset, event.data)
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
      this.changed(this.store.update(current.id, { sessionId: null }))
    }
    this.exitWaiters.get(sessionId)?.()
    if (current) this.capacityReleased?.()
  }

  workingCount(): number {
    return this.store.list().reduce((count, conversation) =>
      count + (conversation.sessionId && this.chats.activity(conversation.id) === 'running' ? 1 : 0), 0)
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
        if (!info || !stage) {
          if (stage) this.store.endStage(stage.id, null)
          this.changed(this.store.update(conversation.id, { sessionId: null }))
          this.capacityReleased?.()
        } else {
          await this.chats.open(this.chatStage(conversation, stage), info.sessionId, this.store.chatOffset(stage.id), false)
          // A question left open across a restart has no browser navigation waiting on it now.
          if (!info.exited) this.chats.cancelAsks(conversation.id)
          if (info.exited) this.handleExit(info.sessionId, info.exitCode ?? -1)
        }
      } catch (error) {
        console.error(`[kando-core] recovering conversation ${conversation.id} failed`, error)
      }
    }
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
    const request = turn ? this.chats.request(conversation.id) : null
    return { ...conversation, starting: this.launching.has(conversation.id), chat: turn ? { turn, ...(suggestion ? { suggestion } : {}), ...(request ? { request } : {}) } : null, chatOptions }
  }

  private changed(value: Conversation): Conversation {
    const decorated = this.withChat(value)
    this.emit({ type: 'changed', conversation: decorated })
    return decorated
  }
}
