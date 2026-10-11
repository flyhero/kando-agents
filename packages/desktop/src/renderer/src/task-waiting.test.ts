import { describe, expect, it } from 'vitest'
import type { Task } from '@kando/protocol'
import { waitingOn } from './task-waiting'

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `任务 ${id}`,
  details: '',
  status: 'pending',
  repos: [],
  dependsOn: [],
  agent: 'claude',
  derivedFrom: null,
  abandonReason: null,
  source: null,
  sourceSnapshot: null,
  images: [],
  awaitingInput: false,
  conversationId: null,
  plan: null,
  launch: {},
  createdAt: 0,
  updatedAt: 0,
  ...patch
})

describe('waitingOn', () => {
  const tasks = {
    open: task('open'),
    running: task('running', { status: 'running' }),
    review: task('review', { status: 'review' }),
    done: task('done', { status: 'done' }),
    gone: task('gone', { status: 'abandoned' })
  }

  it('counts every dependency that is not accepted yet, one under review included', () => {
    const blocked = task('blocked', { dependsOn: ['open', 'running', 'review', 'done', 'gone'] })
    expect(waitingOn(blocked, tasks)).toBe(4)
  })

  it('is nothing once all are done, or for a dependency that no longer exists', () => {
    expect(waitingOn(task('free', { dependsOn: ['done'] }), tasks)).toBe(0)
    expect(waitingOn(task('orphan', { dependsOn: ['deleted'] }), tasks)).toBe(0)
  })

  it('is nothing for a task that already ran', () => {
    expect(waitingOn(task('ran', { status: 'review', dependsOn: ['open'] }), tasks)).toBe(0)
  })
})
