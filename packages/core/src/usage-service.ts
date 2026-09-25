import { AGENT_KINDS, type AgentKind, type AgentUsage } from '@kando/protocol'
import { UsageFetchError, type UsageSource } from './usage-source'

const POLL_MS = 15 * 60_000
// Manual refreshes and session exits come in bursts, and the provider endpoints are rate-limited too.
const MIN_REFRESH_MS = 30_000

export class UsageService {
  private readonly usage = new Map<AgentKind, AgentUsage>()
  private inFlight: Promise<AgentUsage[]> | null = null
  private lastRefresh = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly sources: Record<AgentKind, UsageSource>,
    private readonly emit: (usage: AgentUsage) => void,
    private readonly now: () => number = Date.now
  ) {}

  list(): AgentUsage[] {
    return [...this.usage.values()]
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  // A call within MIN_REFRESH_MS of the previous one answers with the numbers already held.
  refresh(): Promise<AgentUsage[]> {
    if (this.inFlight) {
      return this.inFlight
    }
    if (this.now() - this.lastRefresh < MIN_REFRESH_MS) {
      return Promise.resolve(this.list())
    }
    this.lastRefresh = this.now()
    this.inFlight = Promise.all(AGENT_KINDS.map((agent) => this.refreshAgent(agent))).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async refreshAgent(agent: AgentKind): Promise<AgentUsage> {
    const next = await this.read(agent)
    this.usage.set(agent, next)
    this.emit(next)
    return next
  }

  private async read(agent: AgentKind): Promise<AgentUsage> {
    try {
      const reading = await this.sources[agent]()
      return reading.signedIn
        ? {
            agent,
            status: 'ok',
            windows: reading.windows,
            plan: reading.plan,
            error: null,
            updatedAt: this.now(),
            resetCredits: reading.resetCredits ?? null
          }
        : { agent, status: 'signed-out', windows: [], plan: null, error: null, updatedAt: this.now(), resetCredits: null }
    } catch (error) {
      console.error(`[kando-core] ${agent} usage refresh failed:`, error instanceof Error ? error.message : error)
      const previous = this.usage.get(agent)
      return {
        agent,
        status: 'error',
        windows: previous?.windows ?? [],
        plan: previous?.plan ?? null,
        error: error instanceof UsageFetchError ? error.code : 'request-failed',
        // Keep when the windows were really read, so the UI can tell how stale they are.
        updatedAt: previous?.updatedAt ?? this.now(),
        resetCredits: previous?.resetCredits ?? null
      }
    }
  }
}
