import { describe, expect, it } from 'vitest'
import { limitOf, ScheduledRunList } from './schedule'

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  target: { kind: 'task', taskId: 't1' },
  title: 'Night',
  agent: 'claude',
  notBefore: null,
  resetsAt: null,
  status: 'waiting',
  conversationId: null,
  attempts: 0,
  error: null,
  createdAt: 0,
  settledAt: null
}

describe('ScheduledRunList', () => {
  it('drops a run with a target this client does not know, and keeps the rest', () => {
    const unknown = { ...run, id: '00000000-0000-4000-8000-000000000002', target: { kind: 'telepathy', conversationId: 'x' } }
    expect(ScheduledRunList.parse([run, unknown]).map((each) => each.id)).toEqual([run.id])
  })

  it("reads a routine's run, with an outcome it does not know as none", () => {
    const routineRun = {
      ...run, id: '00000000-0000-4000-8000-000000000003', target: { kind: 'routine', routineId: '00000000-0000-4000-8000-000000000009' },
      routineId: '00000000-0000-4000-8000-000000000009', dueAt: 5, finishedAt: 9, outcome: 'ascended', seenAt: null
    }
    expect(ScheduledRunList.parse([routineRun])).toEqual([expect.objectContaining({ id: routineRun.id, dueAt: 5, finishedAt: 9, outcome: null, seenAt: null })])
  })
})

describe('limitOf', () => {
  it('names the limit a resume answers, or the one a conversation run took over', () => {
    const limit = { stageId: 's', itemId: 'limit:1' }
    expect(limitOf({ kind: 'resume', conversationId: '00000000-0000-4000-8000-000000000003', ...limit })).toEqual(limit)
    expect(limitOf({ kind: 'conversation', conversationId: '00000000-0000-4000-8000-000000000003', text: '', resumes: limit })).toEqual(limit)
    expect(limitOf({ kind: 'conversation', conversationId: '00000000-0000-4000-8000-000000000003', text: '' })).toBeNull()
    expect(limitOf({ kind: 'task', taskId: 't' })).toBeNull()
  })
})
