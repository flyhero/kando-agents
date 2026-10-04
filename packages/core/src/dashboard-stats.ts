import { AGENT_KINDS, DASHBOARD_HISTORY_DAYS, type AgentKind, type DashboardDay, type DashboardModel, type DashboardStats, type DashboardTotals } from '@kando/protocol'
import type { AgentRun } from './agent-run-store'
import type { TurnRow } from './chat-turn-store'
import { median } from './median'

const DAY_MS = 86_400_000

export type DashboardOptions = { range: number; timeZone: string; now: number }

// A task run counts on the day it ended, when its tokens were known; one still going counts nowhere.
// Turns are free conversations' only: a task chat's turns are its run, which counts already.
export function summarizeDashboard(runs: readonly AgentRun[], turns: readonly TurnRow[], options: DashboardOptions): DashboardStats {
  const dayOf = dayKeys(options.timeZone)
  const today = dayOf(options.now)
  const history = calendarDays(today, Math.max(DASHBOARD_HISTORY_DAYS, options.range * 2))
  const current = new Set(history.slice(-options.range))
  const previous = new Set(history.slice(-options.range * 2, -options.range))
  const ended = runs.flatMap((run) => (run.endedAt === null ? [] : [{ run, day: dayOf(run.endedAt), endedAt: run.endedAt }]))
  const counted = turns.map((turn) => ({ turn, day: dayOf(turn.endedAt) }))

  const days = new Map(history.slice(-DASHBOARD_HISTORY_DAYS).map((day): [string, DashboardDay] => [day, { day, runs: 0, accepted: 0, turns: 0, runTokens: 0, turnTokens: 0 }]))
  for (const { run, day } of ended) {
    const entry = days.get(day)
    if (!entry) continue
    entry.runs += 1
    if (run.outcome === 'accepted') entry.accepted += 1
    entry.runTokens += run.totalTokens ?? 0
  }
  for (const { turn, day } of counted) {
    const entry = days.get(day)
    if (!entry) continue
    entry.turns += 1
    entry.turnTokens += turn.totalTokens ?? 0
  }

  const within = (range: Set<string>) => ({
    runs: ended.filter((entry) => range.has(entry.day)).map((entry) => ({ ...entry.run, endedAt: entry.endedAt })),
    turns: counted.filter((entry) => range.has(entry.day)).map((entry) => entry.turn)
  })
  const now = within(current)
  const before = within(previous)
  return {
    days: [...days.values()],
    current: totals(now.runs, now.turns),
    previous: totals(before.runs, before.turns),
    models: byModel(now.runs, now.turns)
  }
}

// The earliest instant summarizeDashboard can count, with a day to spare for any time zone.
export function dashboardSince(options: DashboardOptions): number {
  return options.now - (Math.max(DASHBOARD_HISTORY_DAYS, options.range * 2) + 1) * DAY_MS
}

type EndedRun = AgentRun & { endedAt: number }

function totals(runs: readonly EndedRun[], turns: readonly TurnRow[]): DashboardTotals {
  return {
    ...runCounts(runs),
    turns: turns.length,
    failedTurns: turns.filter((turn) => turn.state === 'failed').length,
    interruptedTurns: turns.filter((turn) => turn.state === 'interrupted').length,
    tokens: tokensOf(runs, turns)
  }
}

function runCounts(runs: readonly EndedRun[]) {
  const accepted = runs.filter((run) => run.outcome === 'accepted').length
  const decided = runs.filter((run) => run.outcome === 'accepted' || run.outcome === 'continued' || run.outcome === 'redone').length
  return { runs: runs.length, decided, accepted, medianRunMs: median(runs.map((run) => run.endedAt - run.startedAt)) }
}

function tokensOf(runs: readonly EndedRun[], turns: readonly TurnRow[]): number {
  return runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0) + turns.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0)
}

// Agents in their usual order, then the models that used the most tokens.
function byModel(runs: readonly EndedRun[], turns: readonly TurnRow[]): DashboardModel[] {
  const groups = new Map<string, { agent: AgentKind; model: string | null; runs: EndedRun[]; turns: TurnRow[] }>()
  const group = (agent: AgentKind, model: string | null) => {
    const key = JSON.stringify([agent, model])
    const found = groups.get(key) ?? { agent, model, runs: [], turns: [] }
    groups.set(key, found)
    return found
  }
  for (const run of runs) group(run.agent, run.model).runs.push(run)
  for (const turn of turns) group(turn.agent, turn.model).turns.push(turn)
  return [...groups.values()]
    .map((entry): DashboardModel => ({
      agent: entry.agent,
      model: entry.model,
      ...runCounts(entry.runs),
      turns: entry.turns.length,
      tokens: tokensOf(entry.runs, entry.turns)
    }))
    .sort((a, b) => AGENT_KINDS.indexOf(a.agent) - AGENT_KINDS.indexOf(b.agent) || b.tokens - a.tokens || b.runs + b.turns - a.runs - a.turns)
}

// YYYY-MM-DD of an instant in the zone.
function dayKeys(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (at) => {
    const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

// The `count` calendar days ending with `last`, oldest first. Plain date arithmetic in UTC: a
// calendar has no daylight saving to skip or repeat a day.
export function calendarDays(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10))
}
