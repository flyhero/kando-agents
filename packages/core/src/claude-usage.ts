import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ResetCredit, ResetCredits, UsageWindow } from '@kando/protocol'
import { fetchUsageJson, parseJson, type UsageReading } from './usage-source'

// The same endpoint Claude Code's /usage reads; it only accepts the OAuth token of a Claude subscription.
// `cedar_ember` is Claude Code's name for the usage-limit resets promotion; asking adds its state.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1'
// The server reports resets only to a client that looks like a recent Claude Code CLI, so the
// request carries the version installed here; this stands in when it cannot be read.
const FALLBACK_CLI_VERSION = '2.1.0'
const VERSION_TIMEOUT_MS = 5_000
const VERSION_TTL_MS = 60 * 60_000
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_TIMEOUT_MS = 5_000
const SESSION_MINUTES = 300
const WEEK_MINUTES = 10_080
const MODEL_WEEKLY_KEYS = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet', seven_day_fable: 'Fable' } as const

const Credentials = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1), subscriptionType: z.string().nullish() })
})

const Reset = z.union([z.string(), z.number()]).nullish()
const Window = z.object({ utilization: z.number().nullish(), resets_at: Reset })

const UsageResponse = z.looseObject({
  five_hour: Window.nullish().catch(null),
  seven_day: Window.nullish().catch(null),
  limits: z
    .array(
      z.object({
        kind: z.string().nullish(),
        percent: z.number().nullish(),
        resets_at: Reset,
        scope: z.object({ model: z.object({ display_name: z.string() }).nullish() }).nullish()
      })
    )
    .nullish()
    .catch(null)
})

// Undocumented and reverse-engineered by the community: every part is optional, and a reply
// that does not fit simply shows no resets.
const Grant = z.object({
  label: z.string().nullish(),
  resets_left: z.number().nullish(),
  ends_at: Reset,
  clears: z.array(z.string()).nullish().catch(null)
})
const ResetProgram = z.object({
  eligible: z.boolean().nullish(),
  ineligible_reason: z.string().nullish(),
  grants: z.array(Grant).nullish().catch(null)
})
const CLEARS: Record<string, UsageWindow['kind']> = { five_hour: 'session', seven_day: 'weekly' }

const execFileAsync = promisify(execFile)

// macOS keeps Claude Code's OAuth credentials in the login keychain; other platforms use a file.
async function readCredentials(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        timeout: KEYCHAIN_TIMEOUT_MS
      })
      if (stdout.trim()) {
        return stdout.trim()
      }
    } catch {
      // No keychain item: fall back to the file, which Claude Code also honors on macOS.
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return readFile(path.join(configDir, '.credentials.json'), 'utf8').catch(() => null)
}

// Seconds or milliseconds since the epoch, or an ISO string.
function parseReset(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? null : parsed
}

function toWindow(
  kind: UsageWindow['kind'],
  model: string | null,
  usedPercent: number | null | undefined,
  resetsAt: string | number | null | undefined
): UsageWindow | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
    return null
  }
  return {
    kind,
    model,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: kind === 'session' ? SESSION_MINUTES : WEEK_MINUTES,
    resetsAt: parseReset(resetsAt)
  }
}

export function parseClaudeUsage(body: unknown): UsageWindow[] {
  const parsed = UsageResponse.safeParse(body)
  if (!parsed.success) {
    return []
  }
  const data = parsed.data
  const windows = [
    toWindow('session', null, data.five_hour?.utilization, data.five_hour?.resets_at),
    toWindow('weekly', null, data.seven_day?.utilization, data.seven_day?.resets_at)
  ]
  const models = new Set<string>()
  for (const limit of data.limits ?? []) {
    const model = limit.scope?.model?.display_name.trim()
    if (limit.kind === 'weekly_scoped' && model && !models.has(model)) {
      models.add(model)
      windows.push(toWindow('weekly', model, limit.percent, limit.resets_at))
    }
  }
  // Older responses report model caps as top-level keys instead of `limits`.
  for (const [key, model] of Object.entries(MODEL_WEEKLY_KEYS)) {
    const window = Window.safeParse(data[key])
    if (window.success && !models.has(model)) {
      windows.push(toWindow('weekly', model, window.data.utilization, window.data.resets_at))
    }
  }
  return windows.filter((window) => window !== null)
}

// Each grant carries some resets; one credit per reset left, soonest to expire first.
export function parseClaudeResets(body: unknown): ResetCredits | null {
  const program = z.object({ cedar_ember: ResetProgram.nullish().catch(null) }).safeParse(body)
  const data = program.success ? program.data.cedar_ember : null
  if (!data) {
    return null
  }
  if (data.eligible === false) {
    // An outdated Claude Code is the one reason the user can do something about.
    return data.ineligible_reason === 'cli_version' ? { available: 0, credits: [], blockedBy: 'cli_version' } : null
  }
  const credits: ResetCredit[] = (data.grants ?? []).flatMap((grant) => {
    const left = Math.max(0, Math.floor(grant.resets_left ?? 0))
    const clears = [...new Set((grant.clears ?? []).flatMap((key) => (CLEARS[key] ? [CLEARS[key]] : [])))]
    const credit = { expiresAt: parseReset(grant.ends_at), label: grant.label?.trim() || null, clears }
    return Array.from({ length: Math.min(left, 50) }, () => credit)
  })
  credits.sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY))
  return credits.length > 0 ? { available: credits.length, credits, blockedBy: null } : null
}

// `claude --version` prints e.g. "2.1.263 (Claude Code)".
export function parseCliVersion(output: string): string | null {
  return /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

let cachedVersion: { version: string; readAt: number } | null = null

// Asked of the installed CLI itself, so the request claims exactly the version the user has.
async function claudeCliVersion(): Promise<string> {
  if (cachedVersion && Date.now() - cachedVersion.readAt < VERSION_TTL_MS) {
    return cachedVersion.version
  }
  let version = FALLBACK_CLI_VERSION
  // On Windows the CLI is a .cmd shim, which only a shell can run; the fallback has to do there.
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: VERSION_TIMEOUT_MS })
      version = parseCliVersion(stdout) ?? FALLBACK_CLI_VERSION
    } catch {
      version = FALLBACK_CLI_VERSION
    }
  }
  cachedVersion = { version, readAt: Date.now() }
  return version
}

export async function readClaudeUsage(): Promise<UsageReading> {
  const credentials = Credentials.safeParse(parseJson(await readCredentials()))
  if (!credentials.success) {
    return { signedIn: false }
  }
  const { accessToken, subscriptionType } = credentials.data.claudeAiOauth
  // Sent as the installed Claude Code CLI, the client this endpoint serves.
  const body = await fetchUsageJson(USAGE_URL, {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': `claude-cli/${await claudeCliVersion()} (external, cli)`
  })
  return {
    signedIn: true,
    windows: parseClaudeUsage(body),
    plan: subscriptionType ?? null,
    resetCredits: parseClaudeResets(body)
  }
}
