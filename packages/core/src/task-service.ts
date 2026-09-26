import {
  checkContinue,
  checkDependencies,
  checkMove,
  checkRedo,
  checkRefine,
  checkRun,
  imageLabel,
  MAX_TASK_IMAGES,
  type AgentKind,
  type FileDiff,
  type ProjectHead,
  type RepoChanges,
  type RpcParsedParams,
  type SourceSnapshot,
  type Task,
  type TaskImage,
  type TaskSession,
  type TaskSource,
  type TaskStatus
} from '@kando/protocol'
import type { SessionInfo } from '@kando/protocol/node'
import { agentCommand, refineCommand, type AgentCommand, type CommandImages, type EventCallback, type McpServer } from './agent-command'
import { agentPrompt, continuePrompt, refinePrompt, type PromptImages } from './agent-prompt'
import type { AttachmentStore } from './attachment-store'
import type { SessionHost } from './daemon-client'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { fileDiff, repoChanges } from './task-changes'
import type { TaskPatch, TaskStore } from './task-store'
import { normalizeRepoPath, prepareRefineWorkspace, prepareWorkspace, projectHead, withKnownWorktrees } from './workspace'

export type TaskEvent = { type: 'changed'; task: Task } | { type: 'deleted'; id: string }

export class TaskService {
  private readonly launching = new Set<string>()

  constructor(
    private readonly store: TaskStore,
    private readonly projects: ProjectRegistry,
    private readonly sessions: SessionHost,
    private readonly worktreesRoot: string,
    private readonly emit: (event: TaskEvent) => void,
    // How a refining agent reaches Kando; injected so tests need no real CLI.
    private readonly refineMcp: (taskId: string) => McpServer,
    private readonly attachments: AttachmentStore,
    // What the agent's hooks run to report its turns back (`kando task-event`); null leaves them out.
    private readonly agentEvents: ((taskId: string, session: TaskSession, agent: AgentKind) => EventCallback) | null = null
  ) {}

  list(status?: TaskStatus): Task[] {
    return this.store.list(status)
  }

  // Accepts a full id or the short prefix the CLI prints.
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

  update({ id, title, details, repos, dependsOn, agent }: RpcParsedParams<'tasks.update'>): Task {
    const task = this.get(id)
    const patch: TaskPatch = { title, details, agent }
    // Editing the details commits them, so an accepted proposal can no longer be undone.
    if (details !== undefined) {
      patch.previousDetails = null
    }
    if (repos !== undefined) {
      // The running agent's worktrees were laid out for the current list.
      if (task.status === 'running') {
        throw new Rejection('task-running', 'repos cannot change while the agent runs')
      }
      patch.repos = withKnownWorktrees(task.repos, repos.map(normalizeRepoPath))
      const current = new Set(task.repos.map((repo) => repo.path))
      this.projects.remember(patch.repos.map((repo) => repo.path).filter((repoPath) => !current.has(repoPath)))
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
    return this.changed(this.store.update(task.id, { status }))
  }

  async run(id: string): Promise<Task> {
    const task = this.get(id)
    const dependencies = this.dependenciesOf(task)
    const blocker = checkRun(task, dependencies)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    const sessionId = await this.launch(task, async () => {
      const workspace = await prepareWorkspace(task, dependencies, this.worktreesRoot)
      // Persist the worktrees first so a failed spawn is retried in the same trees.
      this.store.update(task.id, { repos: workspace.repos })
      const images = await this.images(task)
      const prompt = agentPrompt(task, workspace, dependencies, this.predecessorOf(task), images.prompt)
      return { cwd: workspace.cwd, command: agentCommand(agent, prompt, images.command, this.eventsFor(task.id, 'run', agent)) }
    })
    return this.changed(this.store.update(task.id, { status: 'running', sessionId, lastExit: null, awaitingInput: false }))
  }

  // A fresh session on the task's own worktree and branch: for "nearly right, change this".
  async continue(id: string, note?: string): Promise<Task> {
    const task = this.get(id)
    const dependencies = this.dependenciesOf(task)
    const blocker = checkContinue(task, dependencies)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    const sessionId = await this.launch(task, async () => {
      // Reuses the worktrees the first run made; recreates any the user removed.
      const workspace = await prepareWorkspace(task, dependencies, this.worktreesRoot)
      this.store.update(task.id, { repos: workspace.repos })
      const images = await this.images(task)
      const prompt = continuePrompt(task, workspace, dependencies, images.prompt, note || null)
      return { cwd: workspace.cwd, command: agentCommand(agent, prompt, images.command, this.eventsFor(task.id, 'run', agent)) }
    })
    return this.changed(this.store.update(task.id, { status: 'running', sessionId, lastExit: null, awaitingInput: false }))
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
      repos: task.repos.map((repo) => ({ path: repo.path, worktreePath: null, branch: null })),
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
    this.changed(this.store.update(task.id, { status: 'abandoned', abandonReason: reason || null }))
    return this.changed(this.get(successor.id))
  }

  // Read-only in the repos as they are (or a worktree an earlier run left); see prepareRefineWorkspace.
  async refine(id: string): Promise<Task> {
    const task = this.get(id)
    const blocker = checkRefine(task)
    if (blocker) {
      throw new Rejection(blocker)
    }
    const { agent } = task
    if (!agent) {
      throw new Rejection('invalid-task')
    }
    const dependencies = this.dependenciesOf(task)
    const sessionId = await this.launch(task, async () => {
      const workspace = await prepareRefineWorkspace(task, dependencies)
      const images = await this.images(task)
      const prompt = refinePrompt(task, agent, workspace, dependencies, this.predecessorOf(task), images.prompt)
      const extraDirs = workspace.dirs.filter((dir) => dir !== workspace.cwd)
      const events = this.eventsFor(task.id, 'refine', agent)
      return { cwd: workspace.cwd, command: refineCommand(agent, prompt, this.refineMcp(task.id), extraDirs, images.command, events) }
    })
    return this.changed(this.store.update(task.id, { refineSessionId: sessionId, awaitingInput: false }))
  }

  // A newer proposal replaces an older one: the agent resubmits after each round of feedback.
  propose(id: string, markdown: string): Task {
    const task = this.get(id)
    return this.changed(
      this.store.update(task.id, { proposal: { markdown, agent: task.agent, createdAt: Date.now() } })
    )
  }

  resolveProposal(id: string, action: 'replace' | 'append' | 'discard'): Task {
    const task = this.get(id)
    const { proposal } = task
    if (!proposal) {
      throw new Rejection('no-proposal', 'the task has no pending proposal')
    }
    if (action === 'discard') {
      return this.changed(this.store.update(task.id, { proposal: null }))
    }
    const details =
      action === 'replace' || task.details.trim() === ''
        ? proposal.markdown
        : `${task.details.trimEnd()}\n\n${proposal.markdown}`
    return this.changed(this.store.update(task.id, { details, previousDetails: task.details, proposal: null }))
  }

  restoreDetails(id: string): Task {
    const task = this.get(id)
    if (task.previousDetails === null) {
      throw new Rejection('nothing-to-restore', 'no accepted proposal to undo')
    }
    return this.changed(this.store.update(task.id, { details: task.previousDetails, previousDetails: null }))
  }

  // One launch at a time per task; `prepare` decides where the agent runs and how.
  private async launch(task: Task, prepare: () => Promise<{ cwd: string; command: AgentCommand }>) {
    if (this.launching.has(task.id)) {
      throw new Rejection('run-in-progress')
    }
    this.launching.add(task.id)
    try {
      const { cwd, command } = await prepare()
      const { sessionId } = await this.sessions.request('spawn', {
        command: command.command,
        args: command.args,
        cwd,
        env: { KANDO_TASK_ID: task.id },
        cols: 120,
        rows: 32
      })
      return sessionId
    } finally {
      this.launching.delete(task.id)
    }
  }

  async delete(id: string): Promise<void> {
    const task = this.get(id)
    if (task.status === 'running' && task.sessionId) {
      await this.sessions.request('kill', { sessionId: task.sessionId }).catch(() => {})
    }
    if (task.refineSessionId) {
      await this.sessions.request('kill', { sessionId: task.refineSessionId }).catch(() => {})
    }
    const dependents = this.store.dependents(task.id)
    // Worktrees are left on disk: they may hold the only copy of the agent's work.
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

  // A run that ends waits for review, whatever its exit code: an interactive agent exits 0 whether
  // it finished or was stopped halfway, so the code is kept for the user to see, not to judge by.
  handleSessionExit(sessionId: string, exitCode: number): void {
    const task = this.store.findBySession(sessionId)
    if (task?.status === 'running') {
      this.changed(this.store.update(task.id, { status: 'review', lastExit: { code: exitCode }, awaitingInput: false }))
    }
    // Ending a refining session leaves the task as it was, proposal and all.
    const refining = this.store.findByRefineSession(sessionId)
    if (refining) {
      this.changed(this.store.update(refining.id, { refineSessionId: null, awaitingInput: false }))
    }
  }

  // The daemon's session list is authoritative for local PTYs. A session it no longer knows
  // (it restarted, say) ended in a way nobody saw: its exit code is unknown.
  reconcile(sessions: readonly SessionInfo[]): void {
    const live = new Set(sessions.filter((s) => !s.exited).map((s) => s.sessionId))
    const exitCodes = new Map(sessions.flatMap((s) => (s.exited ? [[s.sessionId, s.exitCode] as const] : [])))
    this.store.list('running').forEach((task) => {
      if (!task.sessionId || !live.has(task.sessionId)) {
        const code = task.sessionId ? (exitCodes.get(task.sessionId) ?? null) : null
        this.changed(this.store.update(task.id, { status: 'review', lastExit: { code }, awaitingInput: false }))
      }
    })
    this.store.refining().forEach((task) => {
      if (task.refineSessionId && !live.has(task.refineSessionId)) {
        this.changed(this.store.update(task.id, { refineSessionId: null, awaitingInput: false }))
      }
    })
  }

  // Reported by the agent's hooks: its turn ended (waiting) or a new one began. Only the session
  // still open counts, so a late event from one that already ended changes nothing.
  agentEvent(id: string, session: TaskSession, waiting: boolean): void {
    const task = this.get(id)
    const open = session === 'run' ? task.status === 'running' : task.refineSessionId !== null
    if (open && task.awaitingInput !== waiting) {
      this.changed(this.store.update(task.id, { awaitingInput: waiting }))
    }
  }

  // Typing into the agent's terminal answers it, whatever the agent reports.
  noteInput(sessionId: string): void {
    const task = this.store.findBySession(sessionId) ?? this.store.findByRefineSession(sessionId)
    if (task?.awaitingInput) {
      this.changed(this.store.update(task.id, { awaitingInput: false }))
    }
  }

  private eventsFor(taskId: string, session: TaskSession, agent: AgentKind): EventCallback | null {
    return this.agentEvents?.(taskId, session, agent) ?? null
  }

  // The task's images as files on this machine: for the prompt, and for the agent's permissions.
  private async images(task: Task): Promise<{ prompt: PromptImages; command: CommandImages }> {
    const attached = await Promise.all(
      task.images.map(async (image, index) => ({ label: imageLabel(image, index), path: await this.attachments.pathOf(image.id) }))
    )
    const source = await Promise.all(
      (task.sourceSnapshot?.images ?? []).map(async (image) => ({ name: image.name, path: await this.attachments.pathOf(image.id) }))
    )
    const present = (list: readonly { path: string | null }[]) => list.flatMap((image) => (image.path ? [image.path] : []))
    return { prompt: { attached, source }, command: { attached: present(attached), all: [...present(attached), ...present(source)] } }
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
}
