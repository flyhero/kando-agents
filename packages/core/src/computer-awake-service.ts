import type { ComputerAwakeMode, ComputerAwakeStatus } from '@kando/protocol'
import type { SessionHost } from './daemon-client'
import type { AwakeConfigStore } from './awake-config'

const RENEW_MS = 30_000
const LEASE_MS = 90_000

// A scheduled run still waiting counts as work: a computer asleep at its time cannot start it.
export function shouldKeepComputerAwake(mode: ComputerAwakeMode, workingAgents: number, scheduledRuns = 0): boolean {
  return mode === 'on' || (mode === 'auto' && workingAgents + scheduledRuns > 0)
}

export class ComputerAwakeService {
  private mode: ComputerAwakeMode = 'off'
  private workingAgents = 0
  private scheduledRuns = 0
  private backend = { active: false, supported: true, problem: null as string | null }
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly daemon: SessionHost,
    private readonly config: AwakeConfigStore,
    private readonly emit: (status: ComputerAwakeStatus) => void
  ) {}

  async start(): Promise<void> {
    this.mode = await this.config.load()
    await this.sync()
    this.timer = setInterval(() => void this.sync(), RENEW_MS)
    this.timer.unref()
  }

  status(): ComputerAwakeStatus {
    return { mode: this.mode, workingAgents: this.workingAgents, scheduledRuns: this.scheduledRuns, ...this.backend }
  }

  async setMode(mode: ComputerAwakeMode): Promise<ComputerAwakeStatus> {
    await this.config.save(mode)
    this.mode = mode
    await this.sync()
    return this.status()
  }

  refresh(workingAgents: number, scheduledRuns = this.scheduledRuns): void {
    if (workingAgents === this.workingAgents && scheduledRuns === this.scheduledRuns) return
    this.workingAgents = workingAgents
    this.scheduledRuns = scheduledRuns
    void this.sync()
  }

  reconnect(): void {
    void this.sync()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    void this.daemon.request('awakeSet', { active: false, leaseMs: LEASE_MS }).catch(() => {})
  }

  private wanted(): boolean {
    return shouldKeepComputerAwake(this.mode, this.workingAgents, this.scheduledRuns)
  }

  private async sync(): Promise<void> {
    try {
      this.backend = await this.daemon.request('awakeSet', { active: this.wanted(), leaseMs: LEASE_MS })
    } catch (error) {
      this.backend = {
        active: false,
        supported: false,
        problem: error instanceof Error ? error.message : String(error)
      }
    }
    this.emit(this.status())
  }
}
