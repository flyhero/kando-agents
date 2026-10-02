import { spawn, type ChildProcess } from 'node:child_process'

const RETRY_MS = 30_000

export type AwakeBackendStatus = {
  active: boolean
  supported: boolean
  problem: string | null
}

type SpawnProcess = (
  file: string,
  args: string[],
  options: { stdio: ['pipe', 'ignore', 'ignore'] }
) => ChildProcess

const WINDOWS_ASSERTION = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KandoAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
$continuous = 0x80000000
$systemRequired = 0x00000001
while ($true) {
  [KandoAwake]::SetThreadExecutionState($continuous -bor $systemRequired) | Out-Null
  Start-Sleep -Seconds 30
}
`

function command(platform: NodeJS.Platform): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: '/usr/bin/caffeinate', args: ['-i', '-s'] }
  if (platform === 'linux') {
    return {
      file: 'systemd-inhibit',
      args: ['--what=sleep:handle-lid-switch', '--why=Kando agent is working', '--mode=block', 'cat']
    }
  }
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ASSERTION]
    }
  }
  return null
}

export class AwakeService {
  private process: ChildProcess | null = null
  private desired = false
  private leaseTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private problem: string | null = null
  private readonly launch: { file: string; args: string[] } | null

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawnProcess: SpawnProcess = spawn
  ) {
    this.launch = command(this.platform)
  }

  set(active: boolean, leaseMs: number): AwakeBackendStatus {
    this.desired = active
    this.clearLease()
    if (!active) {
      this.stop()
      return this.status()
    }
    this.leaseTimer = setTimeout(() => {
      this.desired = false
      this.stop()
    }, leaseMs)
    this.leaseTimer.unref()
    this.start()
    return this.status()
  }

  status(): AwakeBackendStatus {
    return {
      active: this.process !== null,
      supported: this.launch !== null,
      problem: this.launch ? this.problem : `unsupported platform: ${this.platform}`
    }
  }

  dispose(): void {
    this.desired = false
    this.clearLease()
    this.stop()
  }

  private start(): void {
    if (!this.desired || this.process || !this.launch) return
    this.problem = null
    const child = this.spawnProcess(this.launch.file, this.launch.args, { stdio: ['pipe', 'ignore', 'ignore'] })
    this.process = child
    child.once('error', (error) => {
      if (this.process !== child) return
      this.process = null
      this.problem = error.message
      this.retry()
    })
    child.once('exit', (code, signal) => {
      if (this.process !== child) return
      this.process = null
      if (this.desired) {
        this.problem = `awake assertion exited (${signal ?? code ?? 'unknown'})`
        this.retry()
      }
    })
  }

  private retry(): void {
    if (!this.desired || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, RETRY_MS)
    this.retryTimer.unref()
  }

  private stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const child = this.process
    this.process = null
    child?.stdin?.end()
    child?.kill()
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
  }
}
