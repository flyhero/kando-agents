import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { ResetCredits, UsageWindow } from '@kando/protocol'
import { fetchUsageJson, parseJson, type UsageReading } from './usage-source'

// The endpoint behind Codex's /status; only ChatGPT sign-ins have plan limits.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
// Asked only when the usage reply leaves the reset credits out or incomplete.
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const SESSION_MINUTES = 300
const WEEK_MINUTES = 10_080
// Older Codex builds report window lengths a minute off.
const WINDOW_TOLERANCE_MINUTES = 1

// An API-key sign-in has `tokens: null`: it is billed per token and has no windows to show.
const Auth = z.object({
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().nullish() }).nullish()
})

const Window = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_at: z.number().nullish()
})

// Field names as Orca reads them; every part is optional, since the service does not document it.
const Credits = z.object({
  available_count: z.number().nullish().catch(null),
  credits: z
    .array(z.object({ status: z.string().nullish(), expires_at: z.union([z.string(), z.number()]).nullish() }))
    .nullish()
    .catch(null)
})

const UsageResponse = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({ primary_window: Window.nullish().catch(null), secondary_window: Window.nullish().catch(null) })
    .nullish(),
  rate_limit_reset_credits: Credits.nullish().catch(null)
})

// Seconds or milliseconds, as a number or a string, or an ISO date.
function timestamp(value: string | number | null | undefined): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function parseResetCredits(body: unknown): ResetCredits | null {
  const parsed = Credits.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const { available_count, credits } = parsed.data
  const available = (credits ?? []).filter((credit) => credit.status?.toLowerCase() === 'available')
  const count = typeof available_count === 'number' && Number.isFinite(available_count) ? available_count : credits ? available.length : null
  if (count === null) {
    return null
  }
  // Soonest first, credits without an expiry last. Codex's resets are full ones (weekly + 5 hr).
  const listed = available
    .map((credit) => timestamp(credit.expires_at))
    .sort((a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))
    .map((expiresAt) => ({ expiresAt, label: null, clears: ['session' as const, 'weekly' as const] }))
  return { available: Math.max(0, Math.floor(count)), credits: listed, blockedBy: null }
}

function classify(minutes: number | null): UsageWindow['kind'] | null {
  if (minutes === null) {
    return null
  }
  if (Math.abs(minutes - SESSION_MINUTES) <= WINDOW_TOLERANCE_MINUTES) {
    return 'session'
  }
  return Math.abs(minutes - WEEK_MINUTES) <= WINDOW_TOLERANCE_MINUTES ? 'weekly' : null
}

function toWindow(raw: z.infer<typeof Window> | null | undefined, fallback: UsageWindow['kind']): UsageWindow | null {
  if (!raw || !Number.isFinite(raw.used_percent)) {
    return null
  }
  const minutes = raw.limit_window_seconds ? Math.ceil(raw.limit_window_seconds / 60) : null
  const kind = classify(minutes) ?? fallback
  return {
    kind,
    model: null,
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: kind === 'session' ? SESSION_MINUTES : WEEK_MINUTES,
    // Codex reports Unix seconds.
    resetsAt: raw.reset_at ? raw.reset_at * 1000 : null
  }
}

// `resetCredits` is undefined when the reply said nothing about them, null when it said something unreadable.
export function parseCodexUsage(body: unknown): {
  windows: UsageWindow[]
  plan: string | null
  resetCredits: ResetCredits | null | undefined
} {
  const parsed = UsageResponse.safeParse(body)
  if (!parsed.success) {
    return { windows: [], plan: null, resetCredits: undefined }
  }
  const { plan_type, rate_limit, rate_limit_reset_credits } = parsed.data
  // Primary is normally the 5-hour window and secondary the weekly one; durations win when present.
  const windows = [toWindow(rate_limit?.primary_window, 'session'), toWindow(rate_limit?.secondary_window, 'weekly')]
  return {
    windows: windows.filter((window) => window !== null),
    plan: plan_type ?? null,
    resetCredits: rate_limit_reset_credits === undefined ? undefined : parseResetCredits(rate_limit_reset_credits)
  }
}

// Credits are a nice-to-have: failing to read them never fails the usage reading itself.
async function supplementResetCredits(
  known: ResetCredits | null | undefined,
  headers: Record<string, string>
): Promise<ResetCredits | null> {
  // A count with nothing about when they expire is incomplete too; the credits endpoint lists them.
  if (known && (known.available === 0 || known.credits.length > 0)) {
    return known
  }
  try {
    return parseResetCredits(await fetchUsageJson(RESET_CREDITS_URL, headers)) ?? known ?? null
  } catch {
    return known ?? null
  }
}

export async function readCodexUsage(): Promise<UsageReading> {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const raw = await readFile(path.join(home, 'auth.json'), 'utf8').catch(() => null)
  const auth = Auth.safeParse(parseJson(raw))
  const tokens = auth.success ? auth.data.tokens : null
  if (!tokens) {
    return { signedIn: false }
  }
  // Sent as the Codex client, the one this endpoint serves; same headers as Orca.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (tokens.account_id) {
    headers['ChatGPT-Account-Id'] = tokens.account_id
  }
  const usage = parseCodexUsage(await fetchUsageJson(USAGE_URL, headers))
  return { signedIn: true, ...usage, resetCredits: await supplementResetCredits(usage.resetCredits, headers) }
}
