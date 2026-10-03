import { describe, expect, it } from 'vitest'
import { summarizeRuns, type AgentRun } from './agent-run-store'

let next = 0
const run = (fields: Partial<AgentRun>): AgentRun => ({
  id: `run-${++next}`,
  taskId: 'task',
  kind: 'run',
  agent: 'claude',
  model: null,
  effort: null,
  startedAt: 0,
  endedAt: 60_000,
  endedBy: 'submit',
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  workMs: null,
  outcome: null,
  outcomeAt: null,
  ...fields
})

describe('summarizeRuns', () => {
  it('counts each verdict over the ended runs of one agent and model', () => {
    const [stats] = summarizeRuns([
      run({ outcome: 'accepted', endedAt: 10_000 }),
      run({ outcome: 'accepted', endedAt: 30_000 }),
      run({ outcome: 'continued', endedAt: 20_000 }),
      run({ outcome: 'redone', endedAt: 40_000 }),
      run({ outcome: 'closed', endedBy: 'closed' }),
      run({ outcome: null }),
      // Still running: neither a run that ended nor one to judge.
      run({ endedAt: null, endedBy: null })
    ])
    expect(stats).toEqual({
      agent: 'claude',
      model: null,
      runs: 6,
      decided: 4,
      accepted: 2,
      continued: 1,
      redone: 1,
      medianDurationMs: 35_000,
      medianTokens: null
    })
  })

  it('keeps each model apart, known models first, and takes the median of the tokens reported', () => {
    const stats = summarizeRuns([
      run({ agent: 'codex' }),
      run({ model: 'opus', totalTokens: 900 }),
      run({ model: 'sonnet', totalTokens: 100 }),
      run({ model: 'sonnet', totalTokens: 300 }),
      run({})
    ])
    expect(stats.map((each) => [each.agent, each.model, each.runs, each.medianTokens])).toEqual([
      ['claude', 'sonnet', 2, 200],
      ['claude', 'opus', 1, 900],
      ['claude', null, 1, null],
      ['codex', null, 1, null]
    ])
  })
})
