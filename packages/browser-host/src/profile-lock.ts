import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const GONE_WAIT_MS = 5_000
const GONE_POLL_MS = 100

export type ProcessTable = {
  // The full command line, or null for a process that is not there.
  command(pid: number): Promise<string | null>
  parent(pid: number): Promise<number | null>
  alive(pid: number): boolean
  signal(pid: number, signal: NodeJS.Signals): void
}

const ps = async (pid: number, field: 'command' | 'ppid'): Promise<string | null> => {
  try {
    // -ww: a Chromium command line runs far past any column limit, and the profile is near its end.
    const { stdout } = await run('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export const systemProcesses: ProcessTable = {
  command: (pid) => ps(pid, 'command'),
  parent: async (pid) => {
    const value = Number(await ps(pid, 'ppid'))
    return Number.isInteger(value) && value > 0 ? value : null
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: there, but someone else's.
      return error instanceof Error && 'code' in error && error.code === 'EPERM'
    }
  },
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

// The Chromium holding a profile, from the SingletonLock it leaves there: "<host>-<pid>".
export async function profileOwner(profile: string, hostname = os.hostname()): Promise<number | null> {
  const target = await readlink(path.join(profile, 'SingletonLock')).catch(() => null)
  const split = target?.lastIndexOf('-') ?? -1
  if (!target || split < 0 || target.slice(0, split) !== hostname) return null
  const pid = Number(target.slice(split + 1))
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// Chromium refuses a profile another live Chromium holds (exit 21). A host its core lost track of
// keeps its Chromium, and so the profile, for as long as it has tabs; a new host would then fail
// every launch. Only Kando's own is ended: a Chromium on this profile under another browser host.
// Returns the host it ended. Windows Chromium leaves no SingletonLock, so it is not looked for.
export async function freeProfile(profile: string, table: ProcessTable = systemProcesses, waitMs = GONE_WAIT_MS): Promise<number | null> {
  if (process.platform === 'win32') return null
  const owner = await profileOwner(profile)
  if (owner === null || !table.alive(owner)) return null
  if (!(await table.command(owner))?.includes(`--user-data-dir=${profile}`)) return null
  const host = await table.parent(owner)
  if (host === null || host === process.pid || !(await table.command(host))?.includes('browser-host')) return null
  // Asked first, the host closes its browser as on any shutdown.
  table.signal(host, 'SIGTERM')
  if (!(await gone(owner, table, waitMs))) {
    table.signal(owner, 'SIGKILL')
    table.signal(host, 'SIGKILL')
    await gone(owner, table, waitMs)
  }
  return host
}

async function gone(pid: number, table: ProcessTable, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs
  while (table.alive(pid)) {
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS))
  }
  return true
}
