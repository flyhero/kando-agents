import {
  DEFAULT_INSTANCE,
  MAX_IMAGE_NAME_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_SNAPSHOT_LENGTH,
  MAX_TASK_IMAGES,
  SOURCE_KEY_PATTERN,
  SourceIssue,
  type AgentKind,
  type CredentialStatus,
  type RpcParsedParams,
  type SourceDescriptor,
  type SourceInbox,
  type SourceProblem,
  type SourceSnapshot,
  type Task,
  type TaskImage,
  type TaskSource
} from '@kando/protocol'
import type { AttachmentStore } from './attachment-store'
import type { CredentialStore } from './credential-store'
import { Rejection } from './rejection'
import type { SourceConfigStore } from './source-config'
import { sourceProblem, sourceRejection } from './source-error'
import type { FlowOwner, LoginFlows } from './source-login-flow'
import type { SourceCredential, SourceIssueDetail, SourceProvider, SourceSettings } from './source-provider'

const POLL_MS = 15 * 60_000
// Trackers rate-limit per user; a stuck refresh button should not burn through that.
const MIN_REFRESH_MS = 10_000
const CALL_TIMEOUT_MS = 20_000
// Fetching one issue may download its images too.
const FETCH_TIMEOUT_MS = 120_000
const MAX_ISSUES = 200

export type SourceTasks = {
  importedKeys(provider: string, instance: string): Set<string>
  importTask(input: { title: string; agent: AgentKind | null; source: TaskSource; snapshot: SourceSnapshot }): Task
  get(id: string): Task
  setSnapshot(id: string, snapshot: SourceSnapshot): Task
}

export type SourceDismissals = {
  dismissedIssues(provider: string, instance: string): Set<string>
  dismissIssue(provider: string, instance: string, key: string): void
  restoreIssue(provider: string, instance: string, key: string): void
}

export type SourceEvents = {
  inboxChanged(inbox: SourceInbox): void
  listChanged(sources: SourceDescriptor[]): void
}

type InstanceState = {
  // Bumped whenever settings or the credential change, so a request started before is ignored.
  generation: number
  found: SourceIssue[]
  refreshedAt: number | null
  problem: SourceProblem | null
  inFlight: { generation: number; done: Promise<SourceInbox> } | null
  lastRefresh: number
}

type Ready = { provider: SourceProvider; settings: SourceSettings; credential: SourceCredential }

const stateKey = (provider: string, instance: string) => `${provider}/${instance}`

// An image's name comes from the tracker and ends up in prompts: one plain line, kept short.
const imageName = (name: string) =>
  name
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .trim()
    .slice(0, MAX_IMAGE_NAME_LENGTH)

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// What a provider reports is checked like any outside input: an issue that does not fit is dropped.
function acceptIssue(raw: SourceIssue): SourceIssue | null {
  const parsed = SourceIssue.safeParse({ ...raw, title: String(raw.title).slice(0, MAX_ISSUE_TITLE_LENGTH) })
  return parsed.success && isWebUrl(parsed.data.url) ? parsed.data : null
}

// Core's side of every task source: settings and credentials, the polled inbox, and turning an
// issue into a task. Providers are consulted only through the SourceProvider seam.
export class SourceService {
  private readonly states = new Map<string, InstanceState>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly providers: readonly SourceProvider[],
    private readonly config: SourceConfigStore,
    private readonly credentials: CredentialStore,
    private readonly flows: LoginFlows,
    private readonly tasks: SourceTasks,
    private readonly dismissals: SourceDismissals,
    private readonly attachments: AttachmentStore,
    private readonly events: SourceEvents,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    this.refreshAll()
    this.timer = setInterval(() => this.refreshAll(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  list(): SourceDescriptor[] {
    return this.providers.map((provider) => {
      const configured = this.config.list().filter((entry) => entry.provider === provider.id)
      // Every provider shows a default instance, set up or not, so a client has something to fill in.
      const instances = configured.some((entry) => entry.instance === DEFAULT_INSTANCE)
        ? configured
        : [{ provider: provider.id, instance: DEFAULT_INSTANCE, enabled: true, settings: this.defaults(provider) }, ...configured]
      return {
        provider: provider.id,
        name: provider.name,
        settings: [...provider.settings],
        instances: instances.map((entry) => ({
          instance: entry.instance,
          enabled: entry.enabled,
          settings: entry.settings,
          credential: this.credentialStatus(provider, entry.instance)
        }))
      }
    })
  }

  async saveSettings({ provider: id, instance, settings, enabled }: RpcParsedParams<'sources.saveSettings'>) {
    const provider = this.provider(id)
    let normalized: Record<string, string>
    try {
      normalized = provider.normalizeSettings(settings)
    } catch (error) {
      throw sourceRejection(error)
    }
    const previous = this.config.get(id, instance)
    await this.config.save({ provider: id, instance, enabled: enabled ?? previous?.enabled ?? true, settings: normalized })
    // A credential was made for one host; it must not follow a changed site anywhere else.
    const rebound = provider.settings.some(
      (field) => field.bindsCredential && previous && previous.settings[field.key] !== normalized[field.key]
    )
    if (rebound && this.credentials.get(id, instance)) {
      await this.credentials.delete(id, instance)
    }
    this.reset(id, instance)
    void this.refresh(id, instance)
    return this.descriptor(id)
  }

  // The flow commits a credential only once the provider has verified it.
  login(owner: FlowOwner, id: string, instance: string, flowId: string): string {
    const provider = this.provider(id)
    const saved = this.config.get(id, instance)
    if (!saved) {
      throw new Rejection('source-not-configured', 'save the settings before signing in')
    }
    return this.flows.start(owner, { provider: id, instance }, flowId, async (session, signal) => {
      const { credential, account } = await provider.login(session, saved.settings, signal)
      signal.throwIfAborted()
      await this.credentials.set(id, instance, { ...credential, payload: { ...credential.payload }, account, updatedAt: this.now() })
      this.reset(id, instance)
      void this.refresh(id, instance)
      return account
    })
  }

  answer(owner: FlowOwner, flowId: string, promptId: string, value: string): void {
    this.flows.answer(owner, flowId, promptId, value)
  }

  cancelLogin(owner: FlowOwner, flowId: string): void {
    this.flows.cancel(owner, flowId)
  }

  async disconnect(id: string, instance: string): Promise<void> {
    this.provider(id)
    await this.credentials.delete(id, instance)
    this.reset(id, instance)
  }

  inboxes(): SourceInbox[] {
    return this.list().flatMap((descriptor) =>
      descriptor.instances.map((entry) => this.inbox(descriptor.provider, entry.instance))
    )
  }

  inbox(id: string, instance: string): SourceInbox {
    const state = this.state(id, instance)
    const imported = this.tasks.importedKeys(id, instance)
    const dismissed = this.dismissals.dismissedIssues(id, instance)
    const waiting = state.found.filter((issue) => !imported.has(issue.key))
    return {
      provider: id,
      instance,
      active: this.ready(id, instance) !== null,
      items: waiting.filter((issue) => !dismissed.has(issue.key)),
      dismissed: waiting.filter((issue) => dismissed.has(issue.key)),
      refreshedAt: state.refreshedAt,
      refreshing: state.inFlight !== null,
      problem: state.problem
    }
  }

  // A call within MIN_REFRESH_MS of the previous one answers with what is already held.
  refresh(id: string, instance: string): Promise<SourceInbox> {
    this.provider(id)
    const state = this.state(id, instance)
    const ready = this.ready(id, instance)
    if (!ready) {
      return Promise.resolve(this.inbox(id, instance))
    }
    if (state.inFlight) {
      // One started under settings that have since changed finishes unheard, then a fresh one runs.
      return state.inFlight.generation === state.generation ? state.inFlight.done : state.inFlight.done.then(() => this.refresh(id, instance))
    }
    if (this.now() - state.lastRefresh < MIN_REFRESH_MS) {
      return Promise.resolve(this.inbox(id, instance))
    }
    state.lastRefresh = this.now()
    const { generation } = state
    const done = this.call((signal) => ready.provider.list(ready.settings, ready.credential, signal))
      .then(
        (issues) => {
          if (state.generation === generation) {
            state.found = this.acceptIssues(id, issues)
            state.refreshedAt = this.now()
            state.problem = null
          }
        },
        (error: unknown) => {
          if (state.generation === generation) {
            console.error(`[kando-core] ${id}/${instance} refresh failed:`, error instanceof Error ? error.message : error)
            state.problem = sourceProblem(error)
          }
        }
      )
      .finally(() => {
        state.inFlight = null
      })
      .then(() => this.emitInbox(id, instance))
    state.inFlight = { generation, done }
    this.emitInbox(id, instance)
    return done
  }

  async import(id: string, instance: string, rawKey: string, agent: AgentKind | null): Promise<Task> {
    const ready = this.requireReady(id, instance)
    const key = this.checkedKey(ready.provider, rawKey)
    this.assertNotImported(id, instance, key)
    const detail = await this.fetch(ready, key)
    // Checked again: the tracker may have answered with a moved issue's new key, or another
    // click may have imported it while this one waited.
    this.assertNotImported(id, instance, detail.issue.key)
    const task = this.tasks.importTask({
      title: detail.issue.title.trim() || detail.issue.key,
      agent,
      source: { provider: id, instance, name: ready.provider.name, key: detail.issue.key, url: detail.issue.url },
      snapshot: detail.snapshot
    })
    this.emitInbox(id, instance)
    return task
  }

  async resync(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId)
    const { source } = task
    if (!source) {
      throw new Rejection('source-none', 'the task was not imported from a source')
    }
    const detail = await this.fetch(this.requireReady(source.provider, source.instance), source.key)
    return this.tasks.setSnapshot(task.id, detail.snapshot)
  }

  dismiss(id: string, instance: string, key: string): SourceInbox {
    this.provider(id)
    this.dismissals.dismissIssue(id, instance, key)
    return this.emitInbox(id, instance)
  }

  restore(id: string, instance: string, key: string): SourceInbox {
    this.provider(id)
    this.dismissals.restoreIssue(id, instance, key)
    return this.emitInbox(id, instance)
  }

  // Deleting a task puts its issue back in its inbox.
  tasksChanged(): void {
    this.inboxes().forEach((inbox) => this.events.inboxChanged(inbox))
  }

  private refreshAll(): void {
    this.config.list().forEach((entry) => {
      if (this.providers.some((provider) => provider.id === entry.provider)) {
        void this.refresh(entry.provider, entry.instance)
      }
    })
  }

  private async fetch(ready: Ready, key: string): Promise<{ issue: SourceIssue; snapshot: SourceSnapshot }> {
    let raw: SourceIssueDetail
    try {
      raw = await this.call((signal) => ready.provider.fetch(ready.settings, ready.credential, key, signal), FETCH_TIMEOUT_MS)
    } catch (error) {
      throw sourceRejection(error)
    }
    const issue = acceptIssue(raw)
    if (!issue) {
      throw new Rejection('source-request-failed', `${ready.provider.name} answered with an issue core cannot accept`)
    }
    const { images, lost } = await this.storeImages(raw.images ?? [])
    const note = lost > 0 ? `\n\n（还有 ${lost} 张图片没能保存）` : ''
    const text = typeof raw.markdown === 'string' ? raw.markdown : ''
    const markdown = text.slice(0, MAX_SNAPSHOT_LENGTH - note.length) + note
    return { issue, snapshot: { markdown, fetchedAt: this.now(), images } }
  }

  // Each image passes the same checks as one the user uploads; one that fails is counted, not fatal.
  private async storeImages(raw: readonly { name: string; bytes: Uint8Array }[]): Promise<{ images: TaskImage[]; lost: number }> {
    const images: TaskImage[] = []
    let lost = Math.max(0, raw.length - MAX_TASK_IMAGES)
    for (const image of raw.slice(0, MAX_TASK_IMAGES)) {
      try {
        const info = await this.attachments.put(image.bytes)
        if (!images.some((existing) => existing.id === info.id)) {
          images.push({ id: info.id, name: imageName(image.name), width: info.width, height: info.height })
        }
      } catch (error) {
        console.error('[kando-core] an image from a source was not stored:', error instanceof Error ? error.message : error)
        lost += 1
      }
    }
    return { images, lost }
  }

  private acceptIssues(id: string, issues: readonly SourceIssue[]): SourceIssue[] {
    const seen = new Set<string>()
    const accepted = issues.flatMap((raw) => {
      const issue = acceptIssue(raw)
      if (!issue || seen.has(issue.key)) {
        return []
      }
      seen.add(issue.key)
      return [issue]
    })
    if (accepted.length < issues.length) {
      console.error(`[kando-core] ${id}: dropped ${issues.length - accepted.length} malformed or repeated issues`)
    }
    return accepted.slice(0, MAX_ISSUES)
  }

  private call<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
    return run(AbortSignal.timeout(timeoutMs))
  }

  private checkedKey(provider: SourceProvider, rawKey: string): string {
    const key = provider.normalizeKey?.(rawKey) ?? rawKey
    if (!SOURCE_KEY_PATTERN.test(key)) {
      throw new Rejection('source-invalid-key', `not an issue key: ${rawKey}`)
    }
    return key
  }

  private assertNotImported(id: string, instance: string, key: string): void {
    if (this.tasks.importedKeys(id, instance).has(key)) {
      throw new Rejection('source-already-imported', `${key} is already a task`)
    }
  }

  private provider(id: string): SourceProvider {
    const provider = this.providers.find((candidate) => candidate.id === id)
    if (!provider) {
      throw new Rejection('source-unknown', `no task source "${id}"`)
    }
    return provider
  }

  private defaults(provider: SourceProvider): Record<string, string> {
    return Object.fromEntries(provider.settings.flatMap((field) => (field.default ? [[field.key, field.default]] : [])))
  }

  // The environment wins over the store, and only for the default instance: a variable cannot say which one it means.
  private credential(provider: SourceProvider, instance: string): { credential: SourceCredential; source: 'env' | 'store'; account: string | null } | null {
    const fromEnv = instance === DEFAULT_INSTANCE ? (provider.envCredential?.(this.env) ?? null) : null
    if (fromEnv) {
      return { credential: fromEnv, source: 'env', account: null }
    }
    const stored = this.credentials.get(provider.id, instance)
    return stored ? { credential: stored, source: 'store', account: stored.account } : null
  }

  private credentialStatus(provider: SourceProvider, instance: string): CredentialStatus {
    const found = this.credential(provider, instance)
    return { configured: found !== null, source: found?.source ?? null, account: found?.account ?? null }
  }

  private ready(id: string, instance: string): Ready | null {
    const provider = this.providers.find((candidate) => candidate.id === id)
    const saved = this.config.get(id, instance)
    const found = provider && saved?.enabled ? this.credential(provider, instance) : null
    return provider && saved && found ? { provider, settings: saved.settings, credential: found.credential } : null
  }

  private requireReady(id: string, instance: string): Ready {
    this.provider(id)
    const ready = this.ready(id, instance)
    if (!ready) {
      throw new Rejection('source-not-configured', `${id} is not set up, enabled and signed in`)
    }
    return ready
  }

  private state(id: string, instance: string): InstanceState {
    const key = stateKey(id, instance)
    const existing = this.states.get(key)
    if (existing) {
      return existing
    }
    const created: InstanceState = {
      generation: 0,
      found: [],
      refreshedAt: null,
      problem: null,
      inFlight: null,
      lastRefresh: Number.NEGATIVE_INFINITY
    }
    this.states.set(key, created)
    return created
  }

  // New settings or a new credential: what the old ones found no longer answers for this instance.
  private reset(id: string, instance: string): void {
    const state = this.state(id, instance)
    state.generation += 1
    state.found = []
    state.refreshedAt = null
    state.problem = null
    state.lastRefresh = Number.NEGATIVE_INFINITY
    this.events.listChanged(this.list())
    this.emitInbox(id, instance)
  }

  private descriptor(id: string): SourceDescriptor {
    const descriptor = this.list().find((entry) => entry.provider === id)
    if (!descriptor) {
      throw new Rejection('source-unknown', `no task source "${id}"`)
    }
    return descriptor
  }

  private emitInbox(id: string, instance: string): SourceInbox {
    const inbox = this.inbox(id, instance)
    this.events.inboxChanged(inbox)
    return inbox
  }
}
