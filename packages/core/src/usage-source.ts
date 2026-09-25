import type { ResetCredits, UsageWindow } from '@kando/protocol'

export type UsageReading =
  | { signedIn: false }
  | { signedIn: true; windows: UsageWindow[]; plan: string | null; resetCredits?: ResetCredits | null }

export type UsageSource = () => Promise<UsageReading>

export type UsageFailure = 'auth-expired' | 'request-failed'

export class UsageFetchError extends Error {
  constructor(
    readonly code: UsageFailure,
    message: string
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 10_000

export async function fetchUsageJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
  }
  // Access tokens expire between agent runs; the agent's own CLI refreshes them, Kando never writes credentials.
  if (response.status === 401 || response.status === 403) {
    throw new UsageFetchError('auth-expired', `${url} answered ${response.status}`)
  }
  if (!response.ok) {
    throw new UsageFetchError('request-failed', `${url} answered ${response.status}`)
  }
  return response.json()
}

export function parseJson(raw: string | null): unknown {
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
