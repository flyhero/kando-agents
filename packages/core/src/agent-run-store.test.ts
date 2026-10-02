import { describe, expect, it } from 'vitest'
import { summarizeRuns, type AgentRun } from './agent-run-store'

let next = 0
const run = (fields: Partial<AgentRun>): AgentRun => ({
  id: `run-${++next}`,
  taskId: 'task',
  kind: 'run',
  view: 'terminal',
  agent: 'claude',
  model: null,
  effort: null,
  startedAt: 0,
  endedAt: 60_000,
  endedBy: 'exit',
  exitCode: 0,
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
      run({ outcome: 'continued', exitCode: 1, endedAt: 20_000 }),
      run({ outcome: 'redone', exitCode: null, endedAt: 40_000 }),
      run({ outcome: 'closed' }),
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
      endedTerminal: 6,
      abnormalExits: 1,
      medianDurationMs: 35_000,
      medianTokens: null
    })
  })

  it('keeps each model apart, known models first, and takes tokens from chat runs', () => {
    const stats = summarizeRuns([
      run({ agent: 'codex' }),
      run({ view: 'chat', model: 'opus', endedBy: 'submit', exitCode: null, totalTokens: 900 }),
      run({ view: 'chat', model: 'sonnet', endedBy: 'submit', exitCode: null, totalTokens: 100 }),
      run({ view: 'chat', model: 'sonnet', endedBy: 'submit', exitCode: null, totalTokens: 300 }),
      run({})
    ])
    expect(stats.map((each) => [each.agent, each.model, each.runs, each.endedTerminal, each.medianTokens])).toEqual([
      ['claude', 'sonnet', 2, 0, 200],
      ['claude', 'opus', 1, 0, 900],
      ['claude', null, 1, 1, null],
      ['codex', null, 1, 1, null]
    ])
  })
})
