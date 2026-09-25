import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from './daemon-protocol'

// The project shipped as Ripen first. An existing ~/.ripen keeps being used so the
// worktrees registered under it stay valid; fresh installs get ~/.kando.
export function kandoHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  if (env.KANDO_HOME) return path.resolve(env.KANDO_HOME)
  if (env.RIPEN_HOME) return path.resolve(env.RIPEN_HOME)
  const home = path.join(homedir, '.kando')
  const legacy = path.join(homedir, '.ripen')
  return !existsSync(home) && existsSync(legacy) ? legacy : home
}

// sun_path is 104 bytes on macOS and 108 on Linux; leave headroom.
const MAX_SOCKET_PATH_BYTES = 100

export type KandoPaths = {
  home: string
  database: string
  coreEndpoint: string
  worktrees: string
  daemonSocket: string
  // Task source instances and their settings; no secrets.
  sourcesConfig: string
  // Credential records for task sources; owner-only.
  credentials: string
  // Where the first Jira integration kept its settings and token; migrated on start.
  legacyJiraConfig: string
  // Images, by content hash; owner-only.
  attachments: string
  sessions: string
}

export function kandoPaths(home: string = kandoHome()): KandoPaths {
  return {
    home,
    database: databasePath(home),
    coreEndpoint: path.join(home, 'core.json'),
    worktrees: path.join(home, 'worktrees'),
    daemonSocket: daemonSocketPath(home),
    sourcesConfig: path.join(home, 'sources.json'),
    credentials: path.join(home, 'credentials.json'),
    legacyJiraConfig: path.join(home, 'jira.json'),
    attachments: path.join(home, 'attachments'),
    sessions: path.join(home, 'sessions')
  }
}

// A home created under the old name still holds ripen.db; keep opening it.
function databasePath(home: string): string {
  const current = path.join(home, 'kando.db')
  const legacy = path.join(home, 'ripen.db')
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

// Versioned name lets an old daemon keep serving its PTYs while a new one starts.
function daemonSocketPath(home: string): string {
  const name = `daemon-v${DAEMON_PROTOCOL_VERSION}`
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\kando-${name}-${suffix}`
  }
  const inHome = path.join(home, `${name}.sock`)
  return Buffer.byteLength(inHome) <= MAX_SOCKET_PATH_BYTES
    ? inHome
    : path.join(os.tmpdir(), `kando-${name}-${suffix}.sock`)
}
