import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { AGENT_KINDS, AgentKind, isFinished, type AgentStats, type Task } from '@kando/protocol'
import { median } from './median'

// run: the first time an agent worked on the task · continue: picked up again in the same worktree
export const RunKind = z.enum(['run', 'continue'])
// exit: the terminal session ended · submit: the chat task was handed in · closed: marked done
// while the agent still worked
export const RunEnd = z.enum(['exit', 'submit', 'closed'])
// accepted: the user took the result · continued: they sent it back to change · redone: they gave
// up on it and started over · closed: marked done mid-run, which says nothing about the result
export const RunOutcome = z.enum(['accepted', 'continued', 'redone', 'closed'])
export type RunOutcome = z.infer<typeof RunOutcome>

export const AgentRun = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: RunKind,
  view: z.enum(['terminal', 'chat']),
  agent: AgentKind,
  // What a chat run reported; a terminal run's CLI is never told, so these stay null there.
  model: z.string().nullable(),
  effort: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  endedBy: RunEnd.nullable().catch(null),
  // null: not a terminal exit, or one nobody saw (the daemon had restarted).
  exitCode: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  // The agent's own working time, summed over its turns; wall time also counts the user's.
  workMs: z.number().nullable(),
  outcome: RunOutcome.nullable().catch(null),
  outcomeAt: z.number().nullable()
})
export type AgentRun = z.infer<typeof AgentRun>

// What a chat run's turns add up to, read off its conversation when it ends.
export type RunMeasure = Pick<AgentRun, 'model' | 'effort' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'workMs'>

const SELECT = `SELECT id, task_id AS taskId, kind, view, agent, model, effort, started_at AS startedAt,
  ended_at AS endedAt, ended_by AS endedBy, exit_code AS exitCode, input_tokens AS inputTokens,
  output_tokens AS outputTokens, total_tokens AS totalTokens, work_ms AS workMs, outcome,
  outcome_at AS outcomeAt FROM agent_runs`

// Rows live in `agent_runs`, which TaskStore's migrations create. A run is read off how the task's
// status moves, so terminal and chat tasks, and whichever client moved them, are counted alike.
export class AgentRunStore {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  list(): AgentRun[] {
    return this.db.prepare(`${SELECT} ORDER BY started_at, rowid`).all().map((row) => AgentRun.parse(row))
  }

  stats(): AgentStats[] {
    return summarizeRuns(this.list())
  }

  forTask(taskId: string): AgentRun[] {
    return this.db.prepare(`${SELECT} WHERE task_id = ? ORDER BY started_at, rowid`).all(taskId).map((row) => AgentRun.parse(row))
  }

  // `measure` is asked only when a chat run ends, for what its turns up to then add up to.
  transition(before: Task, after: Task, measure: (run: AgentRun, endedAt: number) => RunMeasure | null): void {
    const from = before.status
    const to = after.status
    if (from === to) return
    const at = this.now()
    if (to === 'running') {
      // Sent back to change: the run it picks up from was not right as it stood.
      if (isFinished(from)) this.judge(after.id, 'continued', at, false)
      if (after.agent) this.start(after, after.agent, isFinished(from) ? 'continue' : 'run', at)
      return
    }
    if (from === 'running') {
      const run = this.open(after.id)
      if (!run) return
      // A terminal run of a Kando before 0.11 ended by its agent exiting, how is no longer known.
      const endedBy = to === 'review' ? (after.conversationId ? 'submit' : 'exit') : 'closed'
      const measured = run.view === 'chat' ? measure(run, at) : null
      this.update(run.id, {
        ended_at: at,
        ended_by: endedBy,
        exit_code: null,
        ...(measured ? columns(measured) : {}),
        ...(endedBy === 'closed' ? { outcome: 'closed', outcome_at: at } : {})
      })
      return
    }
    if (from === 'review' && to === 'done') return this.judge(after.id, 'accepted', at, false)
    // Redoing outranks an earlier acceptance: the user has since decided it was not right.
    if (isFinished(from) && to === 'abandoned') return this.judge(after.id, 'redone', at, true)
  }

  private start(task: Task, agent: AgentKind, kind: z.infer<typeof RunKind>, at: number): void {
    this.db
      .prepare('INSERT INTO agent_runs (id, task_id, kind, view, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), task.id, kind, task.conversationId ? 'chat' : 'terminal', agent, at)
  }

  private open(taskId: string): AgentRun | null {
    const row = this.db.prepare(`${SELECT} WHERE task_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(taskId)
    return row ? AgentRun.parse(row) : null
  }

  // The latest ended run takes the verdict; one already judged keeps its own unless overriding.
  private judge(taskId: string, outcome: RunOutcome, at: number, override: boolean): void {
    const row = this.db.prepare(`${SELECT} WHERE task_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(taskId)
    if (!row) return
    const run = AgentRun.parse(row)
    if (run.outcome === 'closed' || (run.outcome !== null && !override)) return
    this.update(run.id, { outcome, outcome_at: at })
  }

  private update(id: string, values: Record<string, SQLInputValue>): void {
    const keys = Object.keys(values)
    this.db.prepare(`UPDATE agent_runs SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((key) => values[key] ?? null), id)
  }
}

// One row per agent and model, from the runs that have ended; agents in their usual order, a
// known model before the unknown one, busier models first.
export function summarizeRuns(runs: readonly AgentRun[]): AgentStats[] {
  const groups = new Map<string, { agent: AgentKind; model: string | null; runs: AgentRun[] }>()
  for (const run of runs) {
    if (run.endedAt === null) continue
    const key = JSON.stringify([run.agent, run.model])
    const group = groups.get(key) ?? { agent: run.agent, model: run.model, runs: [] }
    group.runs.push(run)
    groups.set(key, group)
  }
  const stats = [...groups.values()].map(({ agent, model, runs: group }): AgentStats => {
    const count = (outcome: RunOutcome) => group.filter((run) => run.outcome === outcome).length
    const terminal = group.filter((run) => run.view === 'terminal')
    return {
      agent,
      model,
      runs: group.length,
      decided: count('accepted') + count('continued') + count('redone'),
      accepted: count('accepted'),
      continued: count('continued'),
      redone: count('redone'),
      endedTerminal: terminal.length,
      abnormalExits: terminal.filter((run) => run.exitCode !== null && run.exitCode !== 0).length,
      medianDurationMs: median(group.flatMap((run) => (run.endedAt === null ? [] : [run.endedAt - run.startedAt]))),
      medianTokens: median(group.flatMap((run) => (run.totalTokens === null ? [] : [run.totalTokens])))
    }
  })
  return stats.sort(
    (a, b) =>
      AGENT_KINDS.indexOf(a.agent) - AGENT_KINDS.indexOf(b.agent) ||
      Number(a.model === null) - Number(b.model === null) ||
      b.runs - a.runs
  )
}

function columns(measure: RunMeasure): Record<string, SQLInputValue> {
  return {
    model: measure.model,
    effort: measure.effort,
    input_tokens: measure.inputTokens,
    output_tokens: measure.outputTokens,
    total_tokens: measure.totalTokens,
    work_ms: measure.workMs
  }
}
