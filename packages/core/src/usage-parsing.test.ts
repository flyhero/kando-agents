import { describe, expect, it } from 'vitest'
import { parseClaudeResets, parseClaudeUsage, parseCliVersion } from './claude-usage'
import { parseCodexUsage, parseResetCredits } from './codex-usage'

describe('parseClaudeUsage', () => {
  it('maps the 5-hour and 7-day windows', () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: '2026-09-23T18:00:00Z' },
      seven_day: { utilization: 44, resets_at: 1_790_000_000 },
      seven_day_oauth_apps: null
    })
    expect(windows).toEqual([
      { kind: 'session', model: null, usedPercent: 12.5, windowMinutes: 300, resetsAt: Date.parse('2026-09-23T18:00:00Z') },
      { kind: 'weekly', model: null, usedPercent: 44, windowMinutes: 10_080, resetsAt: 1_790_000_000_000 }
    ])
  })

  it('reads model caps from `limits`, falling back to legacy top-level keys', () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: null },
      limits: [{ kind: 'weekly_scoped', percent: 81, resets_at: null, scope: { model: { display_name: 'Fable' } } }],
      seven_day_fable: { utilization: 5, resets_at: null },
      seven_day_opus: { utilization: 3, resets_at: null }
    })
    expect(windows.map((w) => [w.model, w.usedPercent])).toEqual([
      [null, 0],
      ['Fable', 81],
      ['Opus', 3]
    ])
  })

  it('skips windows without a number and clamps out-of-range values', () => {
    const windows = parseClaudeUsage({ five_hour: { utilization: null }, seven_day: { utilization: 130 } })
    expect(windows.map((w) => [w.kind, w.usedPercent])).toEqual([['weekly', 100]])
  })

  it('tolerates malformed sections', () => {
    expect(parseClaudeUsage({ five_hour: 'soon', limits: 'many', seven_day: { utilization: 1 } })).toHaveLength(1)
    expect(parseClaudeUsage(null)).toEqual([])
  })
})

describe('parseCodexUsage', () => {
  it('classifies windows by duration, not by slot', () => {
    const usage = parseCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: 1_790_000_000 },
        secondary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_at: 1_789_000_000 }
      }
    })
    expect(usage.plan).toBe('plus')
    expect(usage.windows).toEqual([
      { kind: 'weekly', model: null, usedPercent: 30, windowMinutes: 10_080, resetsAt: 1_790_000_000_000 },
      { kind: 'session', model: null, usedPercent: 8, windowMinutes: 300, resetsAt: 1_789_000_000_000 }
    ])
  })

  it('falls back to primary = session and secondary = weekly', () => {
    const usage = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { used_percent: 2, limit_window_seconds: 7 } }
    })
    expect(usage.windows.map((w) => [w.kind, w.usedPercent, w.resetsAt])).toEqual([
      ['session', 1, null],
      ['weekly', 2, null]
    ])
  })

  it('returns nothing for an unexpected payload', () => {
    expect(parseCodexUsage({ rate_limit: 'none' })).toEqual({ windows: [], plan: null })
  })
})

describe('parseResetCredits', () => {
  it('counts the available credits and lists when they expire, soonest first', () => {
    const credits = parseResetCredits({
      available_count: 3,
      total_earned_count: 5,
      credits: [
        { status: 'available', expires_at: '2026-10-23T05:07:00+08:00' },
        { status: 'redeemed', expires_at: '2026-09-01T00:00:00Z' },
        { status: 'AVAILABLE', expires_at: 1791272640 },
        { status: 'available', expires_at: null }
      ]
    })
    expect(credits?.available).toBe(3)
    expect(credits?.credits.map((credit) => credit.expiresAt)).toEqual([1791272640_000, Date.parse('2026-10-23T05:07:00+08:00'), null])
    expect(credits?.credits[0]).toEqual({ expiresAt: 1791272640_000, label: null, clears: ['session', 'weekly'] })
  })

  it('falls back to counting the list, and gives nothing for a reply it cannot read', () => {
    expect(parseResetCredits({ credits: [{ status: 'available', expires_at: 1_791_272_640_000 }] })).toMatchObject({
      available: 1,
      credits: [{ expiresAt: 1_791_272_640_000 }]
    })
    expect(parseResetCredits({})).toBeNull()
    expect(parseResetCredits('nope')).toBeNull()
  })

  it('tells a usage reply without credits apart from one with an empty set', () => {
    expect(parseCodexUsage({ plan_type: 'plus' }).resetCredits).toBeUndefined()
    expect(parseCodexUsage({ plan_type: 'plus', rate_limit_reset_credits: { available_count: 0, credits: [] } }).resetCredits).toEqual({
      available: 0,
      credits: [],
      blockedBy: null
    })
  })
})

describe('parseClaudeResets', () => {
  it('turns each grant into one credit per reset left, soonest to expire first', () => {
    const resets = parseClaudeResets({
      five_hour: { utilization: 40 },
      cedar_ember: {
        eligible: true,
        ineligible_reason: null,
        grants: [
          {
            id: 'g2',
            label: 'Get extra wiggle room to explore Opus 5.5.',
            resets_total: 2,
            resets_left: 2,
            ends_at: '2026-10-23T00:00:00Z',
            clears: ['five_hour', 'seven_day', 'seven_day_overage_included']
          },
          { id: 'g1', label: null, resets_left: 1, ends_at: '2026-10-04T05:44:00Z', clears: ['five_hour'] },
          { id: 'g0', label: 'spent', resets_left: 0, ends_at: '2026-09-30T00:00:00Z' }
        ]
      }
    })
    expect(resets?.available).toBe(3)
    expect(resets?.credits).toEqual([
      { expiresAt: Date.parse('2026-10-04T05:44:00Z'), label: null, clears: ['session'] },
      { expiresAt: Date.parse('2026-10-23T00:00:00Z'), label: 'Get extra wiggle room to explore Opus 5.5.', clears: ['session', 'weekly'] },
      { expiresAt: Date.parse('2026-10-23T00:00:00Z'), label: 'Get extra wiggle room to explore Opus 5.5.', clears: ['session', 'weekly'] }
    ])
  })

  it('says so only when an outdated CLI is why, and shows nothing otherwise', () => {
    expect(parseClaudeResets({ cedar_ember: { eligible: false, ineligible_reason: 'cli_version', grants: [] } })).toEqual({
      available: 0,
      credits: [],
      blockedBy: 'cli_version'
    })
    expect(parseClaudeResets({ cedar_ember: { eligible: false, ineligible_reason: 'surface' } })).toBeNull()
    expect(parseClaudeResets({ cedar_ember: { eligible: true, grants: [] } })).toBeNull()
    expect(parseClaudeResets({ cedar_ember: null })).toBeNull()
    expect(parseClaudeResets({ five_hour: { utilization: 1 } })).toBeNull()
    expect(parseClaudeResets({ cedar_ember: 'weird' })).toBeNull()
  })

  it('reads the version the installed CLI reports', () => {
    expect(parseCliVersion('2.1.263 (Claude Code)\n')).toBe('2.1.263')
    expect(parseCliVersion('command not found')).toBeNull()
  })
})
