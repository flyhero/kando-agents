import { isScheduleOpen, type RequestedTarget, type ScheduledRun, type UnattendedMode } from '@kando/protocol'
import type { Notice } from './attention'
import { perform } from './core-store'
import { dayAndTime, reasonText } from './labels'

export const UNATTENDED_LABEL: Record<UnattendedMode, string> = { acceptEdits: '自动接受编辑', bypass: '全部放行' }

// The hour a night run defaults to: late enough that the day's work is over.
const NIGHT_HOUR = 1

export function createSchedule(target: RequestedTarget, notBefore: number | null): Promise<ScheduledRun | null> {
  return perform((rpc) => rpc.call('schedules.create', { target, notBefore }))
}

export function rescheduleRun(id: string, notBefore: number | null): Promise<ScheduledRun | null> {
  return perform((rpc) => rpc.call('schedules.update', { id, notBefore }))
}

export function cancelSchedule(id: string): Promise<ScheduledRun | null> {
  return perform((rpc) => rpc.call('schedules.cancel', { id }))
}

export function runScheduleNow(id: string): Promise<ScheduledRun | null> {
  return perform((rpc) => rpc.call('schedules.runNow', { id }))
}

export function reorderSchedules(ids: readonly string[]): void {
  void perform((rpc) => rpc.call('schedules.reorder', { ids: [...ids] }))
}

export function clearSchedules(): void {
  void perform((rpc) => rpc.call('schedules.clear', {}))
}

// The next NIGHT_HOUR o'clock after now, in local time.
export function nextNight(now: number): number {
  const at = new Date(now)
  at.setHours(NIGHT_HOUR, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const pad = (value: number) => String(value).padStart(2, '0')

// For <input type="datetime-local">, which reads and writes local time without a zone.
export function toLocalInput(ms: number): string {
  const at = new Date(ms)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// A date and time without an offset is read as local time.
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

// "02:00" today, "明天 02:00", or the date further out.
export function scheduleTime(ms: number, now: number): string {
  const at = new Date(ms)
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) return clock
  if (days === 1) return `明天 ${clock}`
  return dayAndTime(ms)
}

// Where a run stands, in a few words.
export function scheduleState(run: ScheduledRun, now: number): string {
  switch (run.status) {
    case 'waiting':
      if (run.notBefore !== null && run.notBefore > now) return `${scheduleTime(run.notBefore, now)} 之后开始`
      if (run.resetsAt !== null && run.resetsAt > now) return `等额度恢复（${scheduleTime(run.resetsAt, now)}）`
      if (run.attempts > 0) return `没能开始，稍后再试（${reasonText(run.error ?? '', run.error ?? '')}）`
      return run.notBefore === null ? '额度恢复后开始' : '即将开始（同一个 Agent 的预约依次运行）'
    case 'starting':
      return '正在开始'
    case 'started':
      return `${scheduleTime(run.settledAt ?? now, now)} 已开始`
    case 'failed':
      return `没能开始：${reasonText(run.error ?? '', run.error ?? '未知原因')}`
    case 'cancelled':
      return run.error ? `已取消：${reasonText(run.error, run.error)}` : '已取消'
  }
}

export function openRuns(runs: readonly ScheduledRun[]): ScheduledRun[] {
  return runs.filter(isScheduleOpen)
}

// The open runs the user scheduled themselves, as the queue shows them; a routine's open run
// shows under its routine.
export function openQueueRuns(runs: readonly ScheduledRun[]): ScheduledRun[] {
  return openRuns(runs).filter((run) => run.target.kind !== 'routine')
}

export function openRunForTask(runs: readonly ScheduledRun[], taskId: string): ScheduledRun | undefined {
  return openRuns(runs).find((run) => run.target.kind === 'task' && run.target.taskId === taskId)
}

// The runs the user scheduled in a conversation; a resume core scheduled shows on its limit's card.
export function openRunsForConversation(runs: readonly ScheduledRun[], conversationId: string): ScheduledRun[] {
  return openRuns(runs).filter((run) => run.target.kind === 'conversation' && run.target.conversationId === conversationId)
}

// What a run does when it starts, in a few words.
export function runAction(run: Pick<ScheduledRun, 'target'>): string {
  const { target } = run
  if (target.kind === 'task') return '执行任务'
  if (target.kind === 'routine') return '新开会话执行指令'
  if (target.kind === 'resume') return '额度恢复后从中断处继续'
  const pictures = target.images?.length ? `${target.images.length} 张图片` : ''
  if (target.text) return `${target.resumes ? '从中断处继续，并发送：' : '发送：'}${target.text}${pictures ? `（附 ${pictures}）` : ''}`
  if (pictures) return `${target.resumes ? '从中断处继续，并发送' : '发送'} ${pictures}`
  return target.resumes ? '从中断处继续' : '批准计划或按计划开始实现'
}

export const TARGET_LABEL: Record<ScheduledRun['target']['kind'], string> = { task: '任务', conversation: '会话', resume: '续跑', routine: '定时任务' }

// The runs that failed since the last list: told of, as nobody may have been there to see.
export function scheduleNoticesBetween(prev: readonly ScheduledRun[], next: readonly ScheduledRun[]): Notice[] {
  const before = new Map(prev.map((run) => [run.id, run.status]))
  return next.flatMap((run) => {
    const was = before.get(run.id)
    if (run.status !== 'failed' || was === undefined || was === 'failed') return []
    // A routine's runs are told of through the routine (routineNoticesBetween).
    if (run.target.kind === 'routine') return []
    const target = run.target.kind === 'task'
      ? { kind: 'task' as const, id: run.target.taskId }
      : { kind: 'conversation' as const, id: run.target.conversationId }
    const what = run.target.kind === 'resume' ? '额度恢复后没能继续' : '预约没能开始'
    return [{ title: run.title, body: `${what}：${reasonText(run.error ?? '', run.error ?? '未知原因')}`, target }]
  })
}
