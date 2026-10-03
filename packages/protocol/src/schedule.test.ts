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
