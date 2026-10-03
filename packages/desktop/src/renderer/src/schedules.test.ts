import { describe, expect, it } from 'vitest'
import type { ScheduledRun } from '@kando/protocol'
import { fromLocalInput, nextNight, scheduleNoticesBetween, scheduleState, scheduleTime, toLocalInput } from './schedules'

const at = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()

function run(patch: Partial<ScheduledRun>): ScheduledRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    target: { kind: 'task', taskId: 'task-1' },
    title: 'Dark mode',
    agent: 'claude',
    notBefore: null,
    resetsAt: null,
    status: 'waiting',
    conversationId: null,
    attempts: 0,
    error: null,
    createdAt: 0,
    settledAt: null,
    ...patch
  }
}

describe('schedule times', () => {
  it('defaults to the coming night, tomorrow once it has passed', () => {
    expect(nextNight(at(2026, 10, 3, 15))).toBe(at(2026, 10, 4, 1))
    expect(nextNight(at(2026, 10, 4, 0, 30))).toBe(at(2026, 10, 4, 1))
    expect(nextNight(at(2026, 10, 4, 1))).toBe(at(2026, 10, 5, 1))
  })

  it('reads and writes the local time a datetime input holds', () => {
    const ms = at(2026, 10, 4, 1, 5)
    expect(toLocalInput(ms)).toBe('2026-10-04T01:05')
    expect(fromLocalInput('2026-10-04T01:05')).toBe(ms)
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('tomorrow')).toBeNull()
  })

  it('names today by the clock, tomorrow as such, and later days by date', () => {
    const now = at(2026, 10, 3, 15)
    expect(scheduleTime(at(2026, 10, 3, 23, 30), now)).toBe('23:30')
    expect(scheduleTime(at(2026, 10, 4, 1), now)).toBe('明天 01:00')
    expect(scheduleTime(at(2026, 10, 6, 1), now)).toBe('10月6日 01:00')
  })
})

describe('scheduleState', () => {
  const now = at(2026, 10, 3, 15)

  it('says what a waiting run waits for: its time, the quota, a retry, or its turn', () => {
    expect(scheduleState(run({ notBefore: at(2026, 10, 4, 1) }), now)).toBe('明天 01:00 之后开始')
    expect(scheduleState(run({ resetsAt: at(2026, 10, 3, 18) }), now)).toBe('等额度恢复（18:00）')
    expect(scheduleState(run({}), now)).toBe('额度恢复后开始')
    expect(scheduleState(run({ notBefore: at(2026, 10, 3, 1) }), now)).toBe('即将开始（同一个 agent 的预约依次运行）')
    expect(scheduleState(run({ attempts: 1, error: 'chat-busy' }), now)).toBe('没能开始，稍后再试（agent 还在处理上一条消息）')
  })

  it('says how a settled run ended', () => {
    expect(scheduleState(run({ status: 'started', settledAt: at(2026, 10, 3, 2) }), now)).toBe('02:00 已开始')
    expect(scheduleState(run({ status: 'failed', error: 'missing-repo' }), now)).toBe('没能开始：请先添加项目')
    expect(scheduleState(run({ status: 'cancelled', error: 'task-started' }), now)).toBe('已取消：任务已经开始了')
  })
})

describe('scheduleNoticesBetween', () => {
  it('tells of a run that has just failed, once, pointing at what it was for', () => {
    const waiting = run({})
    const failed = run({ status: 'failed', error: 'missing-repo' })
    expect(scheduleNoticesBetween([waiting], [failed])).toEqual([
      { title: 'Dark mode', body: '预约没能开始：请先添加项目', target: { kind: 'task', id: 'task-1' } }
    ])
    expect(scheduleNoticesBetween([failed], [failed])).toEqual([])
    expect(scheduleNoticesBetween([], [failed])).toEqual([])
  })
})
