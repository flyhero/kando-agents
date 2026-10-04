import { nextOccurrence, type Routine, type RoutineAgent, type RoutineFields, type RoutineSchedule, type ScheduledRun } from '@kando/protocol'
import type { Notice } from './attention'
import { perform } from './core-store'
import { AGENT_LABEL, reasonText } from './labels'
import { scheduleState, scheduleTime } from './schedules'

export const ROUTINE_AGENT_LABEL: Record<RoutineAgent, string> = { ...AGENT_LABEL, auto: '自动' }
export const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'] as const

// A run that started this long after the time it stands for was made up for, not run on time.
export const LATE_MS = 10 * 60_000

export function createRoutine(fields: RoutineFields): Promise<Routine | null> {
  return perform((rpc) => rpc.call('routines.create', fields))
}

export function updateRoutine(id: string, patch: Partial<RoutineFields>): Promise<Routine | null> {
  return perform((rpc) => rpc.call('routines.update', { id, ...patch }))
}

export function deleteRoutine(id: string): Promise<{ ok: true } | null> {
  return perform((rpc) => rpc.call('routines.delete', { id }))
}

export function runRoutineNow(id: string): Promise<ScheduledRun | null> {
  return perform((rpc) => rpc.call('routines.runNow', { id }))
}

export function fetchRoutineRuns(routineId: string, before: number | null): Promise<ScheduledRun[] | null> {
  return perform((rpc) => rpc.call('routines.runs', { routineId, before, limit: 50 }))
}

export function markRoutineAllSeen(routineId: string): void {
  void perform((rpc) => rpc.call('routines.markAllSeen', { routineId }))
}

// 每天 09:00 · 工作日 09:00 · 每周一、三 09:00 · 每 3 小时 · 手动
export function scheduleText(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'hourly':
      return schedule.every === 1 ? '每小时' : `每 ${schedule.every} 小时`
    case 'daily':
      return `每天 ${schedule.time}`
    case 'weekdays':
      return `工作日 ${schedule.time}`
    case 'weekly': {
      const days = [...schedule.days].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b)).map((day) => WEEKDAY_LABEL[day] ?? '')
      return `每周${days.join('、')} ${schedule.time}`
    }
    case 'manual':
      return '手动'
  }
}

// When the routine next starts a run, in a few words.
export function nextRunText(routine: Pick<Routine, 'enabled' | 'schedule' | 'nextRunAt'>, now: number): string {
  if (!routine.enabled) return '已暂停'
  if (routine.schedule.kind === 'manual') return '只在手动开始时运行'
  const next = routine.nextRunAt ?? nextOccurrence(routine.schedule, now)
  return next === null ? '没有下一次' : `下次 ${scheduleTime(next, now)}`
}

// Started well after the time it stands for: the computer was asleep, or quota was out.
export function isLate(run: Pick<ScheduledRun, 'status' | 'settledAt' | 'dueAt'>): boolean {
  return run.status === 'started' && run.settledAt !== null && run.dueAt !== null && run.dueAt !== undefined && run.settledAt - run.dueAt > LATE_MS
}

// Where a routine's run stands, in a few words: waiting as any run, else how it went.
export function runOutcomeText(run: ScheduledRun, now: number): string {
  const late = isLate(run) && run.dueAt != null ? `（补跑，原定 ${scheduleTime(run.dueAt, now)}）` : ''
  switch (run.status) {
    case 'waiting':
    case 'starting':
      return scheduleState(run, now)
    case 'failed':
      return `没能开始：${reasonText(run.error ?? '', run.error ?? '未知原因')}`
    case 'cancelled':
      if (run.error === 'previous-running') return '跳过：上一次还没结束'
      return run.error ? `已取消：${reasonText(run.error, run.error)}` : '已取消'
    case 'started': {
      const at = scheduleTime(run.finishedAt ?? run.settledAt ?? now, now)
      switch (run.outcome) {
        case 'completed':
          return `${at} 完成${late}`
        case 'failed':
          return `失败：${reasonText(run.error ?? '', run.error ?? '未知原因')}${late}`
        case 'interrupted':
          return `${run.error ? `中断：${reasonText(run.error, run.error)}` : '中断'}${late}`
        case 'awaiting':
          return `在等你回答${late}`
        default:
          return `${scheduleTime(run.settledAt ?? now, now)} 开始，进行中${late}`
      }
    }
  }
}

export function isUnread(run: Pick<ScheduledRun, 'status' | 'finishedAt' | 'seenAt'>): boolean {
  return !run.seenAt && (run.finishedAt != null || run.status === 'failed')
}

// The conversations of a routine's runs the user has yet to look at, from the latest run of
// each: the dot a conversation's row shows, where one is shown.
export function unreadRoutineConversations(routines: readonly Routine[]): Set<string> {
  return new Set(routines.flatMap((routine) => (routine.lastRun?.conversationId && isUnread(routine.lastRun) ? [routine.lastRun.conversationId] : [])))
}

function outcomeNotice(run: ScheduledRun): string | null {
  if (run.status === 'failed') return `没能开始：${reasonText(run.error ?? '', run.error ?? '未知原因')}`
  if (run.status !== 'started' || run.finishedAt == null) return null
  switch (run.outcome) {
    case 'completed':
      return '做完了'
    case 'failed':
      return `失败：${reasonText(run.error ?? '', run.error ?? '未知原因')}`
    case 'interrupted':
      return run.error ? `中断：${reasonText(run.error, run.error)}` : '中断了'
    case 'awaiting':
      return 'agent 在等你允许或回答'
    default:
      return null
  }
}

// A routine's latest run that just ended, or could not start: told of, as nobody may have been
// there. Judged on the run, so the window's own notice for the conversation does not repeat it.
export function routineNoticesBetween(prev: readonly Routine[], next: readonly Routine[]): Notice[] {
  const before = new Map(prev.map((routine) => [routine.id, routine.lastRun]))
  return next.flatMap((routine) => {
    const run = routine.lastRun
    const was = before.get(routine.id)
    // A routine not known before (the list just loaded, or it was just made) has nothing new.
    if (!run || was === undefined) return []
    const settledNow = was?.id !== run.id || (was.finishedAt == null && run.finishedAt != null) || (was.status !== 'failed' && run.status === 'failed')
      || (was.outcome === 'awaiting' && run.outcome !== 'awaiting')
    if (!settledNow) return []
    const body = outcomeNotice(run)
    if (!body) return []
    const target: Notice['target'] = run.conversationId ? { kind: 'conversation', id: run.conversationId } : { kind: 'routines' }
    return [{ title: `定时任务「${routine.title}」`, body, target }]
  })
}
