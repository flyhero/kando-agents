import { describe, expect, it } from 'vitest'
import { DASHBOARD_HISTORY_DAYS } from '@kando/protocol'
import type { AgentRun } from './agent-run-store'
import type { TurnRow } from './chat-turn-store'
import { calendarDays, summarizeDashboard } from './dashboard-stats'

const HOUR = 3_600_000
// Noon on 2026-10-04 in Shanghai (UTC+8).
const NOW = Date.parse('2026-10-04T04:00:00Z')
const options = { range: 7, timeZone: 'Asia/Shanghai', now: NOW }

let next = 0
const run = (fields: Partial<AgentRun>): AgentRun => ({
  id: `run-${++next}`,
  taskId: 'task',
  kind: 'run',
  agent: 'claude',
  model: 'opus',
  effort: null,
  startedAt: NOW - 2 * HOUR,
  endedAt: NOW - HOUR,
  endedBy: 'submit',
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  workMs: null,
  outcome: null,
  outcomeAt: null,
  ...fields
})

const turn = (fields: Partial<TurnRow>): TurnRow => ({
  conversationId: 'conversation',
  agent: 'claude',
  model: 'opus',
  state: 'completed',
  durationMs: 1000,
  totalTokens: null,
  usageLimit: 0,
  endedAt: NOW - HOUR,
  ...fields
})

describe('summarizeDashboard', () => {
  it('lays out a year of days ending today in the client zone, empty ones included', () => {
    const { days } = summarizeDashboard([], [], options)
    expect(days).toHaveLength(DASHBOARD_HISTORY_DAYS)
    expect(days.at(-1)).toEqual({ day: '2026-10-04', runs: 0, accepted: 0, turns: 0, runTokens: 0, turnTokens: 0 })
    expect(days.at(-2)?.day).toBe('2026-10-03')
  })

  it('counts a run on the local day it ended, and one still going nowhere', () => {
    const stats = summarizeDashboard(
      [
        // 23:30 and 00:30 in Shanghai: both still 10-03 in UTC, but the second is 10-04 to the client.
        run({ endedAt: Date.parse('2026-10-03T15:30:00Z'), totalTokens: 100, outcome: 'accepted' }),
        run({ endedAt: Date.parse('2026-10-03T16:30:00Z'), totalTokens: 50 }),
        run({ endedAt: null, endedBy: null, totalTokens: 999 })
      ],
      [turn({ totalTokens: 7 })],
      options
    )
    expect(stats.days.at(-2)).toMatchObject({ day: '2026-10-03', runs: 1, accepted: 1, runTokens: 100 })
    expect(stats.days.at(-1)).toMatchObject({ day: '2026-10-04', runs: 1, runTokens: 50, turns: 1, turnTokens: 7 })
  })

  it('splits the range from the one before it', () => {
    const daysAgo = (days: number) => NOW - days * 24 * HOUR
    const stats = summarizeDashboard(
      [
        run({ startedAt: daysAgo(1) - HOUR, endedAt: daysAgo(1), outcome: 'accepted', totalTokens: 10 }),
        run({ startedAt: daysAgo(6) - 3 * HOUR, endedAt: daysAgo(6), outcome: 'redone', totalTokens: 20 }),
        run({ endedAt: daysAgo(7), outcome: 'continued', totalTokens: 40 }),
        run({ endedAt: daysAgo(14), totalTokens: 80 })
      ],
      [turn({ endedAt: daysAgo(2), state: 'failed', totalTokens: 1 }), turn({ endedAt: daysAgo(8), state: 'interrupted' })],
      options
    )
    expect(stats.current).toEqual({
      runs: 2,
      decided: 2,
      accepted: 1,
      medianRunMs: 2 * HOUR,
      turns: 1,
      failedTurns: 1,
      interruptedTurns: 0,
      tokens: 31
    })
    expect(stats.previous).toMatchObject({ runs: 1, decided: 1, accepted: 0, turns: 1, interruptedTurns: 1, tokens: 40 })
  })

  it('groups the range by agent and model, agents in order and heavier models first', () => {
    const { models } = summarizeDashboard(
      [
        run({ agent: 'codex', model: 'gpt', totalTokens: 500 }),
        run({ model: 'sonnet', totalTokens: 10 }),
        run({ model: 'opus', totalTokens: 30, outcome: 'accepted' })
      ],
      [turn({ model: 'opus', totalTokens: 5 })],
      options
    )
    expect(models.map((row) => [row.agent, row.model, row.tokens])).toEqual([
      ['claude', 'opus', 35],
      ['claude', 'sonnet', 10],
      ['codex', 'gpt', 500]
    ])
    expect(models[0]).toMatchObject({ runs: 1, decided: 1, accepted: 1, turns: 1, medianRunMs: HOUR })
  })
})

describe('calendarDays', () => {
  it('steps through calendar days across a month end and a daylight saving change', () => {
    expect(calendarDays('2026-11-02', 4)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  })
})
