import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { ENVIRONMENT_TOOLS, type Environment, type EnvironmentCheck, type EnvironmentTool } from '@kando/protocol'

const execFileAsync = promisify(execFile)

const VERSION_TIMEOUT_MS = 5_000
// Looked again only when asked, or this long after: an install does not come and go.
const RESULT_TTL_MS = 5 * 60_000
// What a CLI on Windows is called, in the order a shell tries them.
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat']

type Options = {
  // What the agents are started with: core's own PATH, which the daemon shares.
  pathEnv: string
  platform: NodeJS.Platform
  // Whether the tool has an account to run with; left out for one that has none to have.
  signedIn: Partial<Record<EnvironmentTool, () => Promise<boolean>>>
  now?: () => number
}

// The first of the directories holding an executable of that name; null when none does.
export async function findOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): Promise<string | null> {
  const names = platform === 'win32' ? WINDOWS_EXTENSIONS.map((extension) => `${name}${extension}`) : [name]
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const file of names) {
      const candidate = join(dir, file)
      // Windows has no execute bit; existing is as much as can be asked.
      const executable = await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false)
      if (executable) return candidate
    }
  }
  return null
}

// "git version 2.39.3", "2.1.263 (Claude Code)", "codex-cli 0.156.1": the first dotted triple.
export function parseVersion(output: string): string | null {
  return /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null
}

// Keeps the last look at the machine, so the sidebar and the settings page read one answer.
export class EnvironmentService {
  private last: Environment | null = null
  private pending: Promise<Environment> | null = null
  private readonly now: () => number

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
  }

  check(refresh = false): Promise<Environment> {
    if (this.pending) return this.pending
    if (!refresh && this.last && this.now() - this.last.checkedAt < RESULT_TTL_MS) return Promise.resolve(this.last)
    this.pending = this.look().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async look(): Promise<Environment> {
    const checks = await Promise.all(ENVIRONMENT_TOOLS.map((tool) => this.checkTool(tool)))
    this.last = { checks, searchPath: this.options.pathEnv.split(delimiter).filter(Boolean), checkedAt: this.now() }
    return this.last
  }

  private async checkTool(tool: EnvironmentTool): Promise<EnvironmentCheck> {
    const { pathEnv, platform, signedIn } = this.options
    const path = await findOnPath(tool, pathEnv, platform)
    if (!path) return { tool, status: 'missing', version: null, path: null, signedIn: null }
    // A .cmd shim only a shell can run; the version goes unasked rather than through one.
    const version = platform === 'win32' ? null : await this.version(path)
    return {
      tool,
      status: version === null ? 'unknown' : 'ok',
      version,
      path,
      signedIn: signedIn[tool] ? await signedIn[tool]().catch(() => null) : null
    }
  }

  private async version(file: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true })
      return parseVersion(stdout)
    } catch {
      return null
    }
  }
}
