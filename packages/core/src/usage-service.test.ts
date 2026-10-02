import { describe, expect, it } from 'vitest'
import type { AgentUsage, UsageWindow } from '@kando/protocol'
import { UsageService } from './usage-service'
import { UsageFetchError, type UsageReading } from './usage-source'

const window: UsageWindow = { kind: 'session', model: null, usedPercent: 40, windowMinutes: 300, resetsAt: null }

function setup(claude: () => Promise<UsageReading>) {
  let now = 1_000_000
  const events: AgentUsage[] = []
  const service = new UsageService(
    { claude, codex: async () => ({ signedIn: false }) },
    (usage) => events.push(usage),
    () => now
  )
  return { service, events, advance: (ms: number) => (now += ms) }
}

describe('UsageService', () => {
  it('reads every agent and emits each result', async () => {
    const { service, events } = setup(async () => ({ signedIn: true, windows: [window], plan: 'max' }))
    await service.refresh()
    expect(events.map((e) => [e.agent, e.status])).toEqual([
      ['claude', 'ok'],
      ['codex', 'signed-out']
    ])
    expect(service.list().find((u) => u.agent === 'claude')).toMatchObject({ windows: [window], plan: 'max' })
  })

  it('keeps the last numbers, marked stale, when a refresh fails', async () => {
    let fail = false
    const { service, advance } = setup(async () => {
      if (fail) {
        throw new UsageFetchError('auth-expired', '401')
      }
      return { signedIn: true, windows: [window], plan: null, resetCredits: { available: 1, credits: [{ expiresAt: 5, label: null, clears: [] }], blockedBy: null } }
    })
    await service.refresh()
    fail = true
    advance(60_000)
    const [claude] = await service.refresh()
    expect(claude).toMatchObject({
      status: 'error',
      error: 'auth-expired',
      windows: [window],
      updatedAt: 1_000_000,
      resetCredits: { available: 1, credits: [{ expiresAt: 5, label: null, clears: [] }], blockedBy: null }
    })
  })

  it('answers bursts with the numbers it holds instead of refetching', async () => {
    let calls = 0
    const { service, advance } = setup(async () => {
      calls++
      return { signedIn: true, windows: [], plan: null }
    })
    await Promise.all([service.refresh(), service.refresh()])
    await service.refresh()
    expect(calls).toBe(1)
    advance(30_000)
    await service.refresh()
    expect(calls).toBe(2)
  })

  it('reports unexpected failures as request-failed', async () => {
    const { service } = setup(async () => {
      throw new SyntaxError('bad json')
    })
    const [claude] = await service.refresh()
    expect(claude).toMatchObject({ status: 'error', error: 'request-failed', windows: [] })
  })
})

describe('UsageService.report', () => {
  it('ignores a report older than the reading it holds, refresh and all', async () => {
    let reads = 0
    const { service, events, advance } = setup(async () => {
      reads++
      return { signedIn: true, windows: [window], plan: 'max' }
    })
    await service.refresh()
    events.length = 0
    advance(60_000)
    // As a stage replayed from its log would report the limit it hit an hour ago.
    service.report('claude', { at: 1_000_000 - 3_600_000, windows: [{ ...window, usedPercent: 100 }], refresh: true })
    expect(events).toEqual([])
    expect(service.list().find((u) => u.agent === 'claude')?.windows).toEqual([window])
    expect(reads).toBe(1)
  })

  const weekly: UsageWindow = { kind: 'weekly', model: null, usedPercent: 10, windowMinutes: 10_080, resetsAt: null }
  const opus: UsageWindow = { kind: 'weekly', model: 'Opus', usedPercent: 20, windowMinutes: 10_080, resetsAt: null }

  it('replaces only the windows the agent named, and stamps the reading fresh', async () => {
    const { service, events, advance } = setup(async () => ({ signedIn: true, windows: [window, weekly, opus], plan: 'max' }))
    await service.refresh()
    events.length = 0
    advance(5_000)
    const session = { ...window, usedPercent: 55 }
    service.report('claude', { at: 1_004_000, windows: [session] })
    // Stamped with when the agent said so, not when core passed it on.
    expect(events).toEqual([expect.objectContaining({ agent: 'claude', status: 'ok', plan: 'max', updatedAt: 1_004_000 })])
    expect(service.list().find((u) => u.agent === 'claude')?.windows).toEqual([weekly, opus, session])
  })

  it('shows a report from an agent no poll has read yet', () => {
    const { service, events } = setup(async () => ({ signedIn: false }))
    service.report('codex', { at: 1_000_000, windows: [weekly], plan: 'plus' })
    expect(events).toEqual([expect.objectContaining({ agent: 'codex', status: 'ok', windows: [weekly], plan: 'plus', resetCredits: null })])
  })

  it('asks for a full reading when the report says so, within the usual throttle', async () => {
    let reads = 0
    const { service, events } = setup(async () => {
      reads++
      return { signedIn: true, windows: [window], plan: null }
    })
    service.report('claude', { at: 1_000_000, windows: [], refresh: true })
    // Joins the refresh the report started rather than reading again.
    await service.refresh()
    expect(reads).toBe(1)
    expect(events.filter((e) => e.agent === 'claude')).toHaveLength(1)
  })
})
