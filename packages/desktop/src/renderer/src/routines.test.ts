import { describe, expect, it } from 'vitest'
import type { Routine, ScheduledRun } from '@kando/protocol'
import { isLate, isUnread, nextRunText, routineNoticesBetween, runOutcomeText, scheduleText, unreadRoutineConversations } from './routines'

const at = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()
const ROUTINE_ID = '00000000-0000-4000-8000-000000000101'
const RUN_ID = '00000000-0000-4000-8000-000000000001'

function run(patch: Partial<ScheduledRun>): ScheduledRun {
  return {
    id: RUN_ID,
    target: { kind: 'routine', routineId: ROUTINE_ID },
    title: '日报',
    agent: 'claude',
    notBefore: null,
    resetsAt: null,
    status: 'started',
    conversationId: RUN_ID,
    attempts: 0,
    error: null,
    createdAt: at(2026, 10, 4, 9),
    settledAt: at(2026, 10, 4, 9, 0),
    routineId: ROUTINE_ID,
    dueAt: at(2026, 10, 4, 9),
    finishedAt: at(2026, 10, 4, 9, 5),
    outcome: 'completed',
    seenAt: null,
    ...patch
  }
}

function routine(patch: Partial<Routine>): Routine {
  return {
    id: ROUTINE_ID, title: '日报', enabled: true, schedule: { kind: 'daily', time: '09:00' },
    target: { kind: 'new', agent: 'claude', projectPaths: [], text: '写日报' },
    nextRunAt: at(2026, 10, 5, 9), lastFiredAt: null, unread: 0, lastRun: null, createdAt: 0, updatedAt: 0, ...patch
  }
}

describe('scheduleText', () => {
  it('names each kind of schedule', () => {
    expect(scheduleText({ kind: 'hourly', every: 1 })).toBe('每小时')
    expect(scheduleText({ kind: 'hourly', every: 3 })).toBe('每 3 小时')
    expect(scheduleText({ kind: 'daily', time: '09:00' })).toBe('每天 09:00')
    expect(scheduleText({ kind: 'weekdays', time: '09:00' })).toBe('工作日 09:00')
    expect(scheduleText({ kind: 'weekly', days: [3, 1, 0], time: '18:30' })).toBe('每周一、三、日 18:30')
    expect(scheduleText({ kind: 'manual' })).toBe('手动')
  })
})

describe('nextRunText', () => {
  it('says when the next run is, or why there is none', () => {
    const now = at(2026, 10, 4, 12)
    expect(nextRunText(routine({}), now)).toBe('下次 明天 09:00')
    expect(nextRunText(routine({ nextRunAt: at(2026, 10, 4, 18) }), now)).toBe('下次 18:00')
    expect(nextRunText(routine({ enabled: false }), now)).toBe('已暂停')
    expect(nextRunText(routine({ schedule: { kind: 'manual' }, nextRunAt: null }), now)).toBe('只在手动开始时运行')
  })
})

describe('runOutcomeText', () => {
  const now = at(2026, 10, 4, 12)

  it('tells how a run went, and when it was made up for', () => {
    expect(runOutcomeText(run({}), now)).toBe('09:05 完成')
    expect(runOutcomeText(run({ outcome: 'failed', error: 'chat-start-failed' }), now)).toMatch(/^失败：/)
    expect(runOutcomeText(run({ outcome: 'interrupted', error: 'agent-lost' }), now)).toBe('中断：Agent 没有留下结果就退出了')
    expect(runOutcomeText(run({ outcome: 'awaiting' }), now)).toBe('在等你回答')
    expect(runOutcomeText(run({ outcome: null, finishedAt: null }), now)).toBe('09:00 开始，进行中')
    const late = run({ settledAt: at(2026, 10, 4, 11, 30), finishedAt: at(2026, 10, 4, 11, 35) })
    expect(isLate(late)).toBe(true)
    expect(runOutcomeText(late, now)).toBe('11:35 完成（补跑，原定 09:00）')
    expect(isLate(run({ settledAt: at(2026, 10, 4, 9, 5) }))).toBe(false)
  })

  it('tells of a run that did not start, was skipped, or still waits', () => {
    expect(runOutcomeText(run({ status: 'failed', error: 'chat-option-invalid', finishedAt: null, outcome: null }), now)).toMatch(/^没能开始：/)
    expect(runOutcomeText(run({ status: 'cancelled', error: 'previous-running', finishedAt: null, outcome: null }), now)).toBe('跳过：上一次还没结束')
    expect(runOutcomeText(run({ status: 'cancelled', error: 'routine-paused', finishedAt: null, outcome: null }), now)).toBe('已取消：定时任务已暂停')
    expect(runOutcomeText(run({ status: 'waiting', finishedAt: null, outcome: null, settledAt: null, resetsAt: at(2026, 10, 4, 14) }), now)).toBe('等额度恢复（14:00）')
  })
})

describe('unread', () => {
  it('is a run that ended or never started, until looked at', () => {
    expect(isUnread(run({}))).toBe(true)
    expect(isUnread(run({ seenAt: 1 }))).toBe(false)
    expect(isUnread(run({ finishedAt: null, outcome: null }))).toBe(false)
    expect(isUnread(run({ status: 'failed', finishedAt: null, outcome: null }))).toBe(true)
    expect(unreadRoutineConversations([routine({ lastRun: run({}) }), routine({ id: '00000000-0000-4000-8000-000000000102', lastRun: run({ id: 'x', conversationId: 'x', seenAt: 1 }) })])).toEqual(new Set([RUN_ID]))
  })
})

describe('routineNoticesBetween', () => {
  it('tells of a latest run that just ended or failed to start, under the routine\'s name', () => {
    const before = routine({ lastRun: run({ finishedAt: null, outcome: null }) })
    const done = routine({ lastRun: run({}) })
    expect(routineNoticesBetween([before], [done])).toEqual([{ title: '定时任务「日报」', body: '做完了', target: { kind: 'conversation', id: RUN_ID } }])
    const failed = routine({ lastRun: run({ status: 'failed', error: 'chat-option-invalid', conversationId: null, finishedAt: null, outcome: null }) })
    expect(routineNoticesBetween([before], [failed])[0]).toMatchObject({ body: expect.stringMatching(/^没能开始：/), target: { kind: 'routines' } })
    const asked = routine({ lastRun: run({ outcome: 'awaiting' }) })
    expect(routineNoticesBetween([before], [asked])[0]?.body).toBe('Agent 在等你允许或回答')
    expect(routineNoticesBetween([asked], [done])[0]?.body).toBe('做完了')
  })

  it('says nothing of what was there before, of a routine just learnt of, or of a run still going', () => {
    const done = routine({ lastRun: run({}) })
    expect(routineNoticesBetween([done], [done])).toEqual([])
    expect(routineNoticesBetween([], [done])).toEqual([])
    expect(routineNoticesBetween([routine({})], [routine({ lastRun: run({ finishedAt: null, outcome: null }) })])).toEqual([])
    const skipped = routine({ lastRun: run({ id: 'y', status: 'cancelled', error: 'previous-running', conversationId: null, finishedAt: null, outcome: null }) })
    expect(routineNoticesBetween([done], [skipped])).toEqual([])
  })
})
