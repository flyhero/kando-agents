import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { UsageWindow } from '@kando/protocol'
import { fetchUsageJson, parseJson, type UsageReading } from './usage-source'

// What the Cursor CLI's own /usage asks: Connect RPC with a JSON body, on the CLI's access token.
const DASHBOARD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService'
const KEYCHAIN_SERVICE = 'cursor-access-token'
const KEYCHAIN_ACCOUNT = 'cursor-user'
const KEYCHAIN_TIMEOUT_MS = 5_000
const MONTH_MINUTES = 30 * 24 * 60

const execFileAsync = promisify(execFile)

// macOS keeps the Cursor CLI's login in the keychain; elsewhere, or when told to, it uses auth.json.
async function readAccessToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
        timeout: KEYCHAIN_TIMEOUT_MS
      })
      if (stdout.trim()) {
        return stdout.trim()
      }
    } catch {
      // No keychain item: the CLI may be keeping its login in the file instead.
    }
  }
  const dir = process.platform === 'darwin' ? path.join(os.homedir(), '.cursor') : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'cursor')
  const file = z.object({ accessToken: z.string().min(1) }).safeParse(parseJson(await readFile(path.join(dir, 'auth.json'), 'utf8').catch(() => null)))
  return file.success ? file.data.accessToken : null
}

const Millis = z.union([z.string(), z.number()]).nullish().transform((value) => {
  const numeric = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(numeric) ? numeric : null
})
const Percent = z.number().nullish().catch(null)

const PeriodUsage = z.object({
  billingCycleStart: Millis.catch(null),
  billingCycleEnd: Millis.catch(null),
  planUsage: z.object({ totalPercentUsed: Percent, apiPercentUsed: Percent }).nullish().catch(null)
})

// Cursor's money amounts no longer add up to its progress (a plan shows its included spend all used
// at 9%): the percentages are what Cursor itself shows, so only they are read. Total covers every
// model; API is the share of it for models picked by name rather than Auto.
export function parseCursorUsage(body: unknown): UsageWindow[] {
  const parsed = PeriodUsage.safeParse(body)
  if (!parsed.success || !parsed.data.planUsage) {
    return []
  }
  const { billingCycleStart: start, billingCycleEnd: end, planUsage } = parsed.data
  const windowMinutes = start !== null && end !== null && end > start ? Math.round((end - start) / 60_000) : MONTH_MINUTES
  const window = (model: string | null, percent: number | null | undefined): UsageWindow[] =>
    percent === null || percent === undefined ? [] : [{ kind: 'monthly', model, usedPercent: Math.min(100, Math.max(0, percent)), windowMinutes, resetsAt: end }]
  return [...window(null, planUsage.totalPercentUsed), ...window('API', planUsage.apiPercentUsed)]
}

export function parseCursorPlan(body: unknown): string | null {
  return z.object({ planInfo: z.object({ planName: z.string().min(1) }) }).safeParse(body).data?.planInfo.planName ?? null
}

export async function readCursorUsage(): Promise<UsageReading> {
  const token = await readAccessToken()
  if (!token) {
    return { signedIn: false }
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }
  const [usage, plan] = await Promise.all([
    fetchUsageJson(`${DASHBOARD_URL}/GetCurrentPeriodUsage`, headers, '{}'),
    // The plan's name is a nicety: the numbers stand without it.
    fetchUsageJson(`${DASHBOARD_URL}/GetPlanInfo`, headers, '{}').catch(() => null)
  ])
  return { signedIn: true, windows: parseCursorUsage(usage), plan: parseCursorPlan(plan) }
}
