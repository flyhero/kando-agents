import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readlink } from 'node:fs/promises'
import { ProcessSnapshotData } from '@kando/protocol/node'

const execute = promisify(execFile)
export type ProcessIdentity = { pid: number; parentPid: number; startedAt: string; command: string }
export type Listener = { pid: number; address: string; port: number }
export type ProcessSnapshot = { processes: ProcessIdentity[]; listeners: Listener[] }

async function output(command: string, args: string[]): Promise<string> {
  const result = await execute(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } })
  return result.stdout
}

export function parseProcesses(text: string): ProcessIdentity[] {
  return text.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/)
    if (!match || !match[3] || !match[4]) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3], command: match[4] }]
  })
}

function endpoint(pid: number, value: string): Listener[] {
  const match = value.match(/^(.*):(\d+)$/)
  if (!match || !match[1]) return []
  const port = Number(match[2])
  if (port < 1 || port > 65535) return []
  return [{ pid, address: match[1].replace(/^\[|\]$/g, ''), port }]
}

export function parseLsof(text: string): Listener[] {
  let pid = 0
  let ipv6 = false
  return text.split('\n').flatMap((line) => {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); ipv6 = false }
    if (line.startsWith('t')) ipv6 = line === 'tIPv6'
    const value = line.slice(1)
    return pid > 0 && line.startsWith('n') ? endpoint(pid, ipv6 && value.startsWith('*:') ? `[::]${value.slice(1)}` : value) : []
  })
}

export function parseSs(text: string, family: 4 | 6 = 4): Listener[] {
  return text.split('\n').flatMap((line) => {
    const local = line.trim().split(/\s+/)[3]
    return local ? [...line.matchAll(/pid=(\d+)/g)].flatMap((match) => endpoint(Number(match[1]), family === 6 && local.startsWith('*:') ? `[::]${local.slice(1)}` : local)) : []
  })
}

export function parseProcessFolders(text: string): Map<number, string> {
  const folders = new Map<number, string>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    else if (pid > 0 && line.startsWith('n/')) folders.set(pid, line.slice(1))
  }
  return folders
}

export async function readProcessFolders(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  if (process.platform === 'linux') {
    const folders = await Promise.all([...new Set(pids)].map(async (pid) => [pid, await readlink(`/proc/${pid}/cwd`).catch(() => null)] as const))
    return new Map(folders.flatMap(([pid, folder]) => folder ? [[pid, folder]] : []))
  }
  if (process.platform === 'darwin') {
    return parseProcessFolders(await output('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', [...new Set(pids)].join(',')]).catch(() => ''))
  }
  return new Map()
}

export async function readListeningProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessSnapshot> {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; $procs=@(Get-CimInstance Win32_Process | Where-Object {$null -ne $_.CreationDate} | ForEach-Object {@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.Name}}); $ports=@(Get-NetTCPConnection -State Listen | ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress;port=[int]$_.LocalPort}}); @{processes=$procs;listeners=$ports} | ConvertTo-Json -Depth 4 -Compress"
    return ProcessSnapshotData.parse(JSON.parse(await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])))
  }
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`unsupported platform: ${platform}`)
  let listeners: Listener[]
  if (platform === 'linux') {
    try {
      const [ipv4, ipv6] = await Promise.all([output('ss', ['-H', '-ltnp', '-4']), output('ss', ['-H', '-ltnp', '-6'])])
      listeners = [...parseSs(ipv4, 4), ...parseSs(ipv6, 6)]
      return { processes: parseProcesses(await output('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])), listeners }
    } catch {
      // Minimal Linux installations may have lsof in place of iproute2.
    }
  }
  try {
    listeners = parseLsof(await output('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fptn']))
  } catch (error) {
    // lsof uses exit 1 for an empty result, but a missing binary or permission failure is not empty.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1 && 'stderr' in error && error.stderr === '') listeners = []
    else throw error
  }
  return { processes: parseProcesses(await output('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])), listeners }
}

export async function stopListeningProcess(identity: ProcessIdentity): Promise<void> {
  if (process.platform !== 'win32') {
    process.kill(identity.pid, 'SIGTERM')
    return
  }
  const startedAt = identity.startedAt.replace(/'/g, "''")
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}'; if ($null -eq $p -or $p.CreationDate.ToUniversalTime().ToString('o') -ne '${startedAt}') {throw 'port-process-changed'}; Stop-Process -Id ${identity.pid}`
  await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}
