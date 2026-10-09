import { describe, expect, it } from 'vitest'
import { LEGACY_USAGE_WINDOW_KINDS, QUOTA_STALE_MS, quotaVerdict, tightestWindow, usageLevel, usageReadable, type AgentUsage, type UsageWindow } from './usage'

const window = (usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  kind: 'weekly',
  model: null,
  usedPercent,
  windowMinutes: 10_080,
  resetsAt: null,
  ...extra
})

const NOW = 1_790_000_000_000

const usage = (windows: UsageWindow[], extra: Partial<AgentUsage> = {}): AgentUsage => ({
  agent: 'claude',
  status: 'ok',
  windows,
  plan: 'max',
  error: null,
  updatedAt: NOW,
  resetCredits: null,
  ...extra
})

describe('usageLevel', () => {
  it('warns from 60% and turns critical from 80%', () => {
    expect([0, 59.9, 60, 79.9, 80, 100].map(usageLevel)).toEqual([
      'normal',
      'normal',
      'warning',
      'warning',
      'critical',
      'critical'
    ])
  })
})

describe('tightestWindow', () => {
  it('picks the window closest to its cap', () => {
    expect(tightestWindow([window(10), window(75), window(30)])?.usedPercent).toBe(75)
    expect(tightestWindow([])).toBeNull()
  })
})

describe('quotaVerdict', () => {
  it('knows nothing without a reading or a sign-in', () => {
    expect(quotaVerdict(undefined, NOW)).toEqual({ state: 'unknown', window: null, stale: false })
    expect(quotaVerdict(usage([], { status: 'signed-out' }), NOW).state).toBe('unknown')
    expect(quotaVerdict(usage([]), NOW).state).toBe('unknown')
  })

  it('goes by the tightest window: tight from 80%, exhausted at the cap', () => {
    const session = window(85, { kind: 'session', windowMinutes: 300 })
    expect(quotaVerdict(usage([window(20), session]), NOW)).toEqual({ state: 'tight', window: session, stale: false })
    expect(quotaVerdict(usage([window(100), session]), NOW).state).toBe('exhausted')
    expect(quotaVerdict(usage([window(79)]), NOW).state).toBe('ok')
  })

  it('skips a window that has reset since it was read', () => {
    const reset = window(100, { resetsAt: NOW - 1 })
    expect(quotaVerdict(usage([reset, window(10)]), NOW)).toMatchObject({ state: 'ok', window: { usedPercent: 10 } })
    expect(quotaVerdict(usage([reset]), NOW)).toEqual({ state: 'ok', window: null, stale: false })
  })

  it('counts a model-specific window only for the model it names', () => {
    const reading = usage([window(30), window(100, { model: 'Opus' })])
    expect(quotaVerdict(reading, NOW, 'opus Opus 5.5').state).toBe('exhausted')
    expect(quotaVerdict(reading, NOW, 'sonnet Sonnet 5').state).toBe('ok')
    expect(quotaVerdict(reading, NOW).state).toBe('ok')
  })

  it('flags numbers that failed to refresh or are old', () => {
    expect(quotaVerdict(usage([window(10)], { status: 'error' }), NOW).stale).toBe(true)
    expect(quotaVerdict(usage([window(10)], { updatedAt: NOW - QUOTA_STALE_MS - 1 }), NOW).stale).toBe(true)
    expect(quotaVerdict(usage([window(10)], { updatedAt: NOW - QUOTA_STALE_MS }), NOW).stale).toBe(false)
  })
})

describe('usageReadable', () => {
  it('holds a reading back from a client that does not know one of its window kinds', () => {
    const legacy = new Set(LEGACY_USAGE_WINDOW_KINDS)
    expect(usageReadable(legacy, usage([window(10), window(20, { kind: 'session' })]))).toBe(true)
    expect(usageReadable(legacy, usage([window(10, { kind: 'monthly' })], { agent: 'cursor' }))).toBe(false)
    expect(usageReadable(new Set(['session', 'weekly', 'monthly']), usage([window(10, { kind: 'monthly' })], { agent: 'cursor' }))).toBe(true)
    expect(usageReadable(legacy, usage([], { agent: 'cursor', status: 'signed-out' }))).toBe(true)
  })
})
