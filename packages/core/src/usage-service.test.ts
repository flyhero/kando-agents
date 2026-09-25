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
