import {
  checkChatResume,
  checkContinue,
  checkChangePrimary,
  checkDependencies,
  checkEditProjects,
  checkEditStart,
  checkMove,
  checkRedo,
  checkSavePlan,
  checkStart,
  checkSubmit,
  imageLabel,
  isStartRef,
  MAX_CHAT_IMAGES,
  MAX_TASK_IMAGES,
  startKind,
  type AgentKind,
  type Conversation,
  type FileDiff,
  type ProjectHead,
  type RepoChanges,
  type RepoStartOptions,
  type RpcParsedParams,
  type SourceSnapshot,
  type Task,
  type TaskImage,
  type TaskRepo,
  type TaskSource,
  type TaskStatus
} from '@kando/protocol'
import type { SessionInfo } from '@kando/protocol/node'
import { chatPlanPrompt, chatStartPrompt, continuePrompt, type PromptImages } from './agent-prompt'
import type { AgentRunStore } from './agent-run-store'
import type { AttachmentStore } from './attachment-store'
import type { ConversationService } from './conversation-service'
import type { SessionHost } from './daemon-client'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { fileDiff, repoChanges } from './task-changes'
import type { TaskPatch, TaskStore } from './task-store'
import { normalizeRepoPath, prepareRefineWorkspace, prepareWorkspace, projectHead, removePlanningCheckouts, startOptions, withKnownWorktrees } from './workspace'

export type TaskEvent = { type: 'changed'; task: Task } | { type: 'deleted'; id: string }

// What a task needs of its chat.
export type TaskConversations = Pick<ConversationService, 'startForTask' | 'send' | 'savePlan' | 'stopForTask' | 'deleteForTask' | 'get' | 'runUsage'>

export class TaskService {
  private readonly launching = new Set<string>()

  constructor(
    private readonly store: TaskStore,
    private readonly projects: ProjectRegistry,
    // Only to end the terminal agents a Kando before 0.11 left running (see endTerminalRuns).
    private readonly sessions: SessionHost,
    private readonly worktreesRoot: string,
    private readonly emit: (event: TaskEvent) => void,
    private readonly attachments: AttachmentStore,
    // Where a task's agent runs; null when core has no chat to offer.
    private readonly chats: TaskConversations | null = null,
    // Where each run and the user's verdict on it are kept; null keeps none.
    private readonly runs: AgentRunStore | null = null
  ) {}

  list(status?: TaskStatus): Task[] {
    return this.store.list(status)
  }

  // Accepts a full id or a short prefix of one.
  get(idOrPrefix: string): Task {
    const exact = this.store.get(idOrPrefix)
    if (exact) {
      return exact
    }
    const matches = this.store.findByPrefix(idOrPrefix)
    if (matches.length > 1) {
      throw new Rejection('task-id-ambiguous', `task id "${idOrPrefix}" matches several tasks`)
    }
    const [match] = matches
    if (!match) {
      throw new Rejection('task-not-found', `no task "${idOrPrefix}"`)
    }
    return match
  }

  // The worktree is where this task's agent works; the picked folder is shared with everything else.
  branches(id: string): Promise<ProjectHead[]> {
    return Promise.all(this.get(id).repos.map(async (repo) => repo.worktreePath
      ? { path: repo.path, ...await projectHead(repo.worktreePath) }
      : { path: repo.path, branch: null, detached: false }))
  }

  changes(id: string): Promise<RepoChanges[]> {
    return Promise.all(this.get(id).repos.map(repoChanges))
  }

  async diff(id: string, repoPath: string, file: string): Promise<FileDiff> {
    const repo = this.get(id).repos.find((each) => each.path === repoPath)
    if (!repo) throw new Rejection('repo-not-found', `${repoPath} is not one of the task's repos`)
    return fileDiff(repo, file)
  }

  create({ title, details, repos, dependsOn, agent }: RpcParsedParams<'tasks.create'>): Task {
    // Validate before the row exists, so a bad repo path or id leaves nothing behind.
    const repoPaths = repos && [...new Set(repos.map(normalizeRepoPath))]
    // Nothing depends on a task that does not exist yet, so no loop is possible.
    const dependencyIds = dependsOn && this.resolveIds(dependsOn)
    const task = this.store.create(title)
    if (repoPaths) {
      this.projects.remember(repoPaths)
    }
    const patch: TaskPatch = {
      details,
      agent,
      repos: repoPaths && withKnownWorktrees([], repoPaths),
      dependsOn: dependencyIds
    }
    const hasFields = Object.values(patch).some((value) => value !== undefined)
    return this.changed(hasFields ? this.store.update(task.id, patch) : task)
  }

  // A task made from an issue: the issue's text stays in its snapshot and the details start empty,
  // for the user (or a refining agent) to write the plan in. No repos yet: issues rarely say which.
  importTask({ title, agent, source, snapshot }: { title: string; agent: AgentKind | null; source: TaskSource; snapshot: SourceSnapshot }): Task {
    const task = this.store.create(title)
    return this.changed(this.store.update(task.id, { agent, source, sourceSnapshot: snapshot }))
  }

  // Keys of the issues tasks were imported from, abandoned ones included: a redo keeps its source.
  importedKeys(provider: string, instance: string): Set<string> {
    return new Set(
      this.store
        .list()
        .flatMap((task) => (task.source?.provider === provider && task.source.instance === instance ? [task.source.key] : []))
    )
  }

  // Images are checked before the task exists, so a bad one leaves nothing behind.
  async createTask({ images, ...fields }: RpcParsedParams<'tasks.create'>): Promise<Task> {
    const resolved = await this.resolveImages(images ?? [])
    const task = this.create(fields)
    return resolved.length ? this.changed(this.store.update(task.id, { images: resolved })) : task
  }

  // Appended here rather than sent as a whole list, so images uploaded together all land.
  async addImages(id: string, refs: readonly { id: string; name: string }[]): Promise<Task> {
    const task = this.get(id)
    const added = await this.resolveImages(refs)
    // Read again: another add may have landed while this one checked the files.
    const images = [...this.get(task.id).images]
    for (const image of added) {
      if (!images.some((existing) => existing.id === image.id)) {
        images.push(image)
      }
    }
    if (images.length > MAX_TASK_IMAGES) {
      throw new Rejection('too-many-images', `a task holds at most ${MAX_TASK_IMAGES} images`)
    }
    return this.changed(this.store.update(task.id, { images }))
  }

  private async resolveImages(refs: readonly { id: string; name: string }[]): Promise<TaskImage[]> {
    const images: TaskImage[] = []
    for (const ref of refs) {
      const info = await this.attachments.info(ref.id)
      if (!info) {
        throw new Rejection('attachment-not-found', `no image ${ref.id}`)
      }
      if (!images.some((image) => image.id === ref.id)) {
        images.push({ id: ref.id, name: ref.name.trim(), width: info.width, height: info.height })
      }
    }
    if (images.length > MAX_TASK_IMAGES) {
      throw new Rejection('too-many-images', `a task holds at most ${MAX_TASK_IMAGES} images`)
    }
    return images
  }

  updateImage(id: string, attachmentId: string, name: string): Task {
    const task = this.get(id)
    const images = task.images.map((image) => (image.id === attachmentId ? { ...image, name: name.trim() } : image))
    return this.changed(this.store.update(task.id, { images }))
  }

  removeImage(id: string, attachmentId: string): Task {
    const task = this.get(id)
    // The file stays: other tasks may show the same image, and nothing is deleted automatically yet.
    return this.changed(this.store.update(task.id, { images: task.images.filter((image) => image.id !== attachmentId) }))
  }

  setSnapshot(id: string, snapshot: SourceSnapshot): Task {
    const task = this.get(id)
    return this.changed(this.store.update(task.id, { sourceSnapshot: snapshot }))
  }

  update({ id, title, details, repos, dependsOn, agent, starts }: RpcParsedParams<'tasks.update'>): Task {
    const task = this.get(id)
    const patch: TaskPatch = { title, details, agent }
    if (repos !== undefined) {
      const blocker = checkEditProjects(task, this.launching.has(task.id))
      if (blocker) throw new Rejection(blocker)
      patch.repos = withKnownWorktrees(task.repos, repos.map(normalizeRepoPath))
      if (patch.repos[0]?.path !== task.repos[0]?.path) {
        const fixed = checkChangePrimary(task)
        if (fixed) throw new Rejection(fixed)
      }
      const current = new Set(task.repos.map((repo) => repo.path))
      this.projects.remember(patch.repos.map((repo) => repo.path).filter((repoPath) => !current.has(repoPath)))
    }
    if (starts !== undefined) {
      patch.repos = this.withStarts(task, patch.repos ?? task.repos, starts)
    }
    if (dependsOn !== undefined) {
      const ids = this.resolveIds(dependsOn)
      const blocker = checkDependencies((other) => this.store.dependsOn(other), task.id, ids)
      if (blocker) {
        throw new Rejection(blocker, 'a task cannot depend on itself, directly or through others')
      }
      patch.dependsOn = ids
    }
    return this.changed(this.store.update(task.id, patch))
  }

  // Only a ref of the form a start takes is kept: whether the repo has it is known when the branch
  // is made, and the picker only offers what it has.
  private withStarts(task: Task, repos: readonly TaskRepo[], starts: NonNullable<RpcParsedParams<'tasks.update'>['starts']>): TaskRepo[] {
    const picked = new Map(starts.map(({ path: repoPath, ref }) => [normalizeRepoPath(repoPath), ref]))
    for (const [repoPath, ref] of picked) {
      const repo = repos.find((each) => each.path === repoPath)
      if (!repo) throw new Rejection('repo-not-found', `${repoPath} is not one of the task's repos`)
      const blocker = checkEditStart(task, repo, this.launching.has(task.id))
      if (blocker) throw new Rejection(blocker)
      if (ref !== null && !isStartRef(ref)) throw new Rejection('invalid-start', `${ref} is not a branch to start from`)
    }
    return repos.map((repo) => {
      const ref = picked.get(repo.path)
      return ref === undefined ? repo : { ...repo, startRef: ref }
    })
  }

  // Tasks whose agent is at work in their worktrees.
  async inUse(): Promise<ReadonlySet<string>> {
    return new Set(this.store.list().flatMap((task) =>
      task.conversationId !== null && this.chatTurn(task.conversationId) === 'running' ? [task.id] : []))
  }

  private chatTurn(conversationId: string): string | null {
    try {
      return this.chats?.get(conversationId).chat?.turn ?? null
    } catch {
      return null
    }
  }

  // A worktree is about to go: the task's chat agent, idle in it, is stopped first. One at work, or
  // a task still starting, keeps it.
  async releaseAgent(id: string): Promise<void> {
    const task = this.get(id)
    if (this.launching.has(task.id)) throw new Rejection('run-in-progress')
    if (!task.conversationId || !this.chats) return
    if (this.chats.get(task.conversationId).chat?.turn === 'running') throw new Rejection('worktree-in-use')
    await this.chats.stopForTask(task.id)
  }

  // The worktree was cleaned: running the task again lays it out anew from its branch.
  forgetWorktree(id: string, worktreePath: string): void {
    const task = this.store.get(id)
    if (!task?.repos.some((repo) => repo.worktreePath === worktreePath)) return
    this.changed(this.store.update(task.id, { repos: task.repos.map((repo) => (repo.worktreePath === worktreePath ? { ...repo, worktreePath: null } : repo)) }))
  }

  startOptions(id: string): Promise<RepoStartOptions[]> {
    const task = this.get(id)
    return startOptions(task, this.dependenciesOf(task))
  }

  // Full ids or short prefixes, deduplicated.
  private resolveIds(refs: readonly string[]): string[] {
    return [...new Set(refs.map((ref) => this.get(ref).id))]
  }

  move(id: string, status: TaskStatus): Task {
    const task = this.get(id)
    const blocker = checkMove(task, status)
    if (blocker) {
      throw new Rejection(blocker, `cannot move task from ${task.status} to ${status}`)
    }
    return this.changed(this.save(task.id, { status }))
  }

  // Picks a finished task up again on its own worktree and branch: for "nearly right, change this".
  // The note goes to the agent as the next message of the task's chat.
  async continue(id: string, note?: string, allowBypass?: boolean): Promise<Task> {
    const chats = this.requireChats()
    const task = this.get(id)
    const dependencies = this.dependenciesOf(task)
    const blocker = checkContinue(task, dependencies)
    if (blocker) {
      throw new Rejection(blocker)
    }
    if (task.conversationId) {
      const resumed = await this.resumeChat(id, allowBypass)
      if (note) await chats.send(task.conversationId, note)
      return resumed
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    // Run in a terminal before 0.11, so it has no chat yet: one starts on the worktrees that run
    // left (laid out again if the user removed them), told where the work stands.
    return this.launchChat(task, async () => {
      const workspace = await prepareWorkspace(task, dependencies, this.worktreesRoot)
      this.store.update(task.id, { repos: workspace.repos })
      const images = await this.images(task)
      const conversation = await chats.startForTask({ id: task.id, title: task.title, agent }, {
        cwd: workspace.cwd, extraDirs: workspace.extraDirs, planOnly: false, session: 'new', readable: images.readable, allowBypass
      })
      this.save(task.id, { status: 'running', awaitingInput: false })
      await chats.send(conversation.id, continuePrompt(task, workspace, dependencies, images.prompt, note || null), this.chatImageIds(task, images.prompt))
      return this.changed(this.get(task.id))
    })
  }

  // For "wrong approach, start over": the done task is abandoned, keeping its worktree,
  // and a new pending task takes its place, starting from a clean branch. Returns it.
  redo(id: string, reason: string | undefined): Task {
    const task = this.get(id)
    const blocker = checkRedo(task)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const successor = this.store.create(task.title)
    this.store.update(successor.id, {
      details: task.details,
      agent: task.agent,
      // The new attempt starts where this one was asked to, on a branch of its own.
      repos: task.repos.map((repo) => ({ path: repo.path, worktreePath: null, branch: null, startRef: repo.startRef, start: null })),
      dependsOn: task.dependsOn,
      derivedFrom: task.id,
      source: task.source,
      sourceSnapshot: task.sourceSnapshot,
      images: task.images
    })
    // The abandoned attempt will never be done, so whatever waited on it waits on the redo.
    this.store.dependents(task.id).forEach((dependent) => {
      const dependsOn = [...new Set(dependent.dependsOn.map((other) => (other === task.id ? successor.id : other)))]
      this.changed(this.store.update(dependent.id, { dependsOn }))
    })
    this.changed(this.save(task.id, { status: 'abandoned', abandonReason: reason || null }))
    // The successor starts clean, without the chat; the abandoned one keeps it to read, idle.
    void this.chats?.stopForTask(task.id).catch(() => {})
    return this.changed(this.get(successor.id))
  }

  // A task started in the chat view plans first. Once everything it builds on is done, it does so in
  // its worktree and carries the plan out there; before that, only read-only in its projects,
  // keeping the plan for when it can run. Resolves once the first message is on its way.
  async start(id: string, allowBypass?: boolean): Promise<Task> {
    const chats = this.requireChats()
    const task = this.get(id)
    const dependencies = this.dependenciesOf(task)
    const blocker = checkStart(task, dependencies)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    return this.launchChat(task, async () => {
      const images = await this.images(task)
      const imageIds = this.chatImageIds(task, images.prompt)
      if (startKind(dependencies) === 'plan') {
        const workspace = await prepareRefineWorkspace(task, dependencies, this.worktreesRoot)
        const conversation = await chats.startForTask({ id: task.id, title: task.title, agent }, {
          cwd: workspace.cwd, extraDirs: workspace.dirs.filter((dir) => dir !== workspace.cwd), planOnly: true, session: 'new',
          readable: images.readable, allowBypass
        })
        await chats.send(conversation.id, chatPlanPrompt(task, workspace, dependencies, this.predecessorOf(task), images.prompt), imageIds)
        return this.changed(this.get(task.id))
      }
      // The worktrees are kept before the agent starts, so a failed start is retried in the same trees.
      const workspace = await prepareWorkspace(task, dependencies, this.worktreesRoot)
      this.store.update(task.id, { repos: workspace.repos })
      const conversation = await chats.startForTask({ id: task.id, title: task.title, agent }, {
        cwd: workspace.cwd, extraDirs: workspace.extraDirs, planOnly: false, session: 'new', readable: images.readable, allowBypass
      })
      // The planning agent stopped for the new stage, so nothing reads there any more.
      await removePlanningCheckouts(task.id, this.worktreesRoot)
      this.save(task.id, { status: 'running', awaitingInput: false })
      const prompt = chatStartPrompt(task, workspace, dependencies, this.predecessorOf(task), images.prompt, task.plan)
      await chats.send(conversation.id, prompt, imageIds)
      return this.changed(this.get(task.id))
    })
  }

  // Readies a chat task's agent before a message goes to it: planning goes on read-only, work goes on
  // in the worktrees (laid out again, so one the user removed comes back), on the same session. A
  // finished task goes back to running, as continuing it does.
  async resumeChat(id: string, allowBypass?: boolean): Promise<Task> {
    const chats = this.requireChats()
    const task = this.get(id)
    const dependencies = this.dependenciesOf(task)
    const blocker = checkChatResume(task, dependencies)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    return this.launchChat(task, async () => {
      const images = await this.images(task)
      if (task.status === 'pending') {
        const workspace = await prepareRefineWorkspace(task, dependencies, this.worktreesRoot, { refresh: false })
        await chats.startForTask({ id: task.id, title: task.title, agent }, {
          cwd: workspace.cwd, extraDirs: workspace.dirs.filter((dir) => dir !== workspace.cwd), planOnly: true, session: 'resume',
          readable: images.readable, allowBypass
        })
        return this.get(task.id)
      }
      const workspace = await prepareWorkspace(task, dependencies, this.worktreesRoot)
      this.store.update(task.id, { repos: workspace.repos })
      await chats.startForTask({ id: task.id, title: task.title, agent }, {
        cwd: workspace.cwd, extraDirs: workspace.extraDirs, planOnly: false, session: 'resume', readable: images.readable, allowBypass
      })
      return task.status === 'running' ? this.get(task.id) : this.changed(this.save(task.id, { status: 'running', awaitingInput: false }))
    })
  }

  // A chat task is handed in for review by the user: its agent does not end with the work.
  submit(id: string): Task {
    const task = this.get(id)
    const turn = task.conversationId ? (this.requireChats().get(task.conversationId).chat?.turn ?? null) : null
    const blocker = checkSubmit(task, turn)
    if (blocker) {
      throw new Rejection(blocker)
    }
    return this.changed(this.save(task.id, { status: 'review', awaitingInput: false }))
  }

  // Keeps the plan a task's read-only chat proposed, for when the task can run.
  async savePlan(id: string, stageId: string, requestId: string): Promise<Task> {
    const task = this.get(id)
    const blocker = checkSavePlan(task)
    if (blocker) {
      throw new Rejection(blocker)
    }
    if (!task.conversationId) {
      throw new Rejection('no-chat')
    }
    const kept = await this.requireChats().savePlan(task.conversationId, stageId, requestId)
    return this.changed(this.store.update(task.id, { plan: { ...kept, approved: false, stageId, requestId, createdAt: Date.now() } }))
  }

  // A plan approved in the task's chat is the one it carries out.
  recordPlan(taskId: string, plan: { markdown: string; agent: AgentKind; stageId: string; requestId: string }): void {
    if (this.store.get(taskId)) {
      this.changed(this.store.update(taskId, { plan: { ...plan, approved: true, createdAt: Date.now() } }))
    }
  }

  // Flags a task whose agent waits on the user: a running task whose agent is not working (it may
  // be gone), a planning one whose agent is up and not working.
  chatChanged(conversation: Conversation): void {
    const task = conversation.taskId ? this.store.get(conversation.taskId) : null
    if (!task) {
      return
    }
    const turn = conversation.chat?.turn ?? null
    const waiting = task.status === 'running' ? turn !== 'running' : task.status === 'pending' && (turn === 'idle' || turn === 'awaiting')
    if (task.awaitingInput !== waiting) {
      this.changed(this.store.update(task.id, { awaitingInput: waiting }))
    }
  }

  private requireChats(): TaskConversations {
    if (!this.chats) {
      throw new Rejection('chat-unavailable', 'this core runs no chat-mode agents')
    }
    return this.chats
  }

  // One start at a time per task.
  private async launchChat<T>(task: Task, run: () => Promise<T>): Promise<T> {
    if (this.launching.has(task.id)) {
      throw new Rejection('run-in-progress')
    }
    this.launching.add(task.id)
    try {
      return await run()
    } finally {
      this.launching.delete(task.id)
    }
  }

  // The user's images still on this machine go with the first message; the prompt lists them too.
  private chatImageIds(task: Task, images: PromptImages): string[] {
    return task.images.filter((_, index) => images.attached[index]?.path).slice(0, MAX_CHAT_IMAGES).map((image) => image.id)
  }

  async delete(id: string): Promise<void> {
    const task = this.get(id)
    const dependents = this.store.dependents(task.id)
    await this.chats?.deleteForTask(task.id)
    // Worktrees are left on disk: they may hold the only copy of the agent's work. Planning
    // checkouts hold none, so they go, unless one holds changes after all.
    await removePlanningCheckouts(task.id, this.worktreesRoot)
    this.store.delete(task.id)
    this.emit({ type: 'deleted', id: task.id })
    // Their dependency edges went with the task.
    dependents.forEach((dependent) => {
      const updated = this.store.get(dependent.id)
      if (updated) {
        this.changed(updated)
      }
    })
  }

  // A Kando before 0.11 ran task agents in terminals. One still open there would go on working in
  // a worktree nobody sees any more, so it is ended; a task left running had only that agent, so
  // it goes for review as it would have once the agent exited.
  async endTerminalRuns(sessions: readonly SessionInfo[]): Promise<void> {
    const live = new Set(sessions.filter((session) => !session.exited).map((session) => session.sessionId))
    for (const { id, sessionIds } of this.store.terminalSessions()) {
      for (const sessionId of sessionIds.filter((each) => live.has(each))) {
        await this.sessions.request('kill', { sessionId }).catch(() => {})
      }
      this.store.forgetTerminalSessions(id)
    }
    this.store.list('running')
      .filter((task) => !task.conversationId)
      .forEach((task) => this.changed(this.save(task.id, { status: 'review', awaitingInput: false })))
  }

  // The task's images as files on this machine: for the prompt, and for what the agent may read.
  private async images(task: Task): Promise<{ prompt: PromptImages; readable: string[] }> {
    const attached = await Promise.all(
      task.images.map(async (image, index) => ({ label: imageLabel(image, index), path: await this.attachments.pathOf(image.id) }))
    )
    const source = await Promise.all(
      (task.sourceSnapshot?.images ?? []).map(async (image) => ({ name: image.name, path: await this.attachments.pathOf(image.id) }))
    )
    const present = (list: readonly { path: string | null }[]) => list.flatMap((image) => (image.path ? [image.path] : []))
    return { prompt: { attached, source }, readable: [...present(attached), ...present(source)] }
  }

  private predecessorOf(task: Task): Task | null {
    return task.derivedFrom ? this.store.get(task.derivedFrom) : null
  }

  private dependenciesOf(task: Task): Task[] {
    return task.dependsOn.map((id) => this.store.get(id)).filter((dependency) => dependency !== null)
  }

  private changed(task: Task): Task {
    this.emit({ type: 'changed', task })
    return task
  }

  // Every status change goes through here, so a run is counted however the task moved. Keeping
  // the record is secondary: failing to never fails the move itself.
  private save(id: string, patch: TaskPatch): Task {
    const before = this.store.get(id)
    const after = this.store.update(id, patch)
    if (this.runs && before) {
      try {
        this.runs.transition(before, after, (run, endedAt) =>
          after.conversationId && this.chats ? this.chats.runUsage(after.conversationId, run.startedAt, endedAt) : null)
      } catch (error) {
        console.error('[kando-core] recording the run failed:', error instanceof Error ? error.message : error)
      }
    }
    return after
  }
}
