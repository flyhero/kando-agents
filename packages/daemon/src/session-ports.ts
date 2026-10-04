import type { HostedPort, PortRef } from '@kando/protocol'
import { readListeningProcesses, readProcessFolders, stopListeningProcess, type ProcessIdentity, type ProcessSnapshot } from './listening-processes'

export type PortSession = { sessionId: string; pid: number; canStopRoot: boolean }

export function sessionPorts(snapshot: ProcessSnapshot, sessions: readonly PortSession[]): HostedPort[] {
  const processes = new Map(snapshot.processes.map((each) => [each.pid, each]))
  const roots = new Map(sessions.map((each) => [each.pid, each]))
  const ports: HostedPort[] = []
  const seen = new Set<string>()
  for (const listener of snapshot.listeners) {
    const identity = processes.get(listener.pid)
    if (!identity) continue
    let ancestor: ProcessIdentity | undefined = identity
    let owner: PortSession | undefined
    const visited = new Set<number>()
    while (ancestor && !visited.has(ancestor.pid)) {
      visited.add(ancestor.pid)
      owner = roots.get(ancestor.pid)
      if (owner) break
      ancestor = processes.get(ancestor.parentPid)
    }
    if (!owner) continue
    const key = `${listener.pid}/${listener.address}/${listener.port}`
    if (seen.has(key)) continue
    seen.add(key)
    ports.push({ ...listener, sessionId: owner.sessionId, startedAt: identity.startedAt, command: identity.command, canStop: listener.pid !== owner.pid || owner.canStopRoot })
  }
  return ports.sort((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address))
}

export class SessionPorts {
  constructor(
    private readonly sessions: () => PortSession[],
    private readonly snapshot: () => Promise<ProcessSnapshot> = readListeningProcesses,
    private readonly stopProcess: (identity: ProcessIdentity) => Promise<void> = stopListeningProcess,
    private readonly folders: (pids: readonly number[]) => Promise<Map<number, string>> = readProcessFolders
  ) {}

  async list(): Promise<HostedPort[]> {
    const ports = sessionPorts(await this.snapshot(), this.sessions())
    const folders = await this.folders(ports.map((port) => port.pid))
    return ports.map((port) => ({ ...port, ...(folders.has(port.pid) ? { cwd: folders.get(port.pid) } : {}) }))
  }

  async stop(ref: PortRef): Promise<void> {
    const snapshot = await this.snapshot()
    const port = sessionPorts(snapshot, this.sessions()).find((each) => each.sessionId === ref.sessionId && each.pid === ref.pid && each.startedAt === ref.startedAt && each.port === ref.port && each.address === ref.address)
    if (!port) throw new Error('port-process-changed')
    if (!port.canStop) throw new Error('port-process-protected')
    const identity = snapshot.processes.find((each) => each.pid === port.pid)
    if (!identity) throw new Error('port-process-changed')
    await this.stopProcess(identity)
  }
}
