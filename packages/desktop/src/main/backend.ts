import { execFile, spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { CoreEndpoint } from '@kando/protocol'
import { kandoPaths, readCoreEndpoint } from '@kando/protocol/node'

// Where CLIs land that a Finder-launched app's minimal PATH misses.
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
const START_WAIT_MS = 15_000

// A GUI app inherits launchd's PATH, which has no homebrew or ~/.local: the agents and the
// user's shell live there, so ask the login shell once and pass the result down.
function loginShellPath(): Promise<string> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(shell, ['-l', '-c', 'echo -n "$PATH"'], { timeout: 3000 }, (error, stdout) => {
      const parts = (error ? (process.env.PATH ?? '') : stdout).split(':').filter(Boolean)
      for (const dir of EXTRA_PATH_DIRS) {
        if (!parts.includes(dir)) parts.push(dir)
      }
      resolve(parts.join(':'))
    })
  })
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const settle = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(800, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

// The core serving this home, if one answers on its port.
async function runningCore(): Promise<CoreEndpoint | null> {
  const endpoint = await readCoreEndpoint()
  return endpoint !== null && (await reachable(endpoint.port)) ? endpoint : null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Asks an older core to leave, and waits for it to: it closes its server and removes its endpoint
// file on SIGTERM. Sessions live in the daemon, so the agents it served run on; the new core takes
// them up again.
async function retireCore(endpoint: CoreEndpoint): Promise<void> {
  console.log(`[kando] core ${endpoint.version ?? '(unversioned)'} is older than this app (${app.getVersion()}); replacing it`)
  try {
    process.kill(endpoint.pid, 'SIGTERM')
  } catch {
    return
  }
  const until = Date.now() + 10_000
  while (Date.now() < until && (await reachable(endpoint.port))) await sleep(200)
}

// Starts daemon and core from the app's bundled copies when none serve this KANDO_HOME yet, or when
// the core that does is older than the app: an app updated in place would otherwise keep talking
// to the core it found, and lack whatever the update put in core. Both are detached with their own
// logs: closing the window or quitting the app never touches them, exactly as when they run from
// source. A daemon already serving the socket makes the spawned one exit by itself
// (endpoint-claim), so starting one is safe to over-ask.
export async function ensureBackend(): Promise<void> {
  if (!app.isPackaged) return
  const running = await runningCore()
  if (running?.version === app.getVersion()) return
  if (running) await retireCore(running)
  const paths = kandoPaths()
  const logs = join(paths.home, 'logs')
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  const backend = join(process.resourcesPath, 'backend')
  const env = {
    ...process.env,
    PATH: await loginShellPath(),
    // The Electron binary doubles as the Node that runs them; each strips or scopes the flag
    // before anything of the user's inherits it.
    ELECTRON_RUN_AS_NODE: '1',
    KANDO_CLI_JS: join(backend, 'cli.mjs')
  }
  const launch = (name: 'daemon' | 'core') => {
    const log = openSync(join(logs, `${name}.log`), 'a')
    spawn(process.execPath, [join(backend, `${name}.mjs`)], {
      env,
      detached: true,
      stdio: ['ignore', log, log]
    }).unref()
  }
  launch('daemon')
  launch('core')
  // The renderer retries on its own; waiting here only surfaces a start that never lands.
  const until = Date.now() + START_WAIT_MS
  while (Date.now() < until) {
    if (await runningCore()) return
    await sleep(300)
  }
  console.error(`[kando] core did not come up; see ${join(logs, 'core.log')}`)
}
