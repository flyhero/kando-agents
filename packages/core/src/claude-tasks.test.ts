import { describe, expect, it } from 'vitest'
import { ClaudeTasks } from './claude-tasks'

describe('ClaudeTasks', () => {
  it('takes a whole list from TodoWrite, as older Claude Code versions keep it', () => {
    const tasks = new ClaudeTasks()
    tasks.call('TodoWrite', 'toolu_1', { todos: [{ content: 'Parse', status: 'completed' }, { content: 'Test', status: 'in_progress', activeForm: 'Testing' }] })
    expect(tasks.list()).toEqual([
      { content: 'Parse', status: 'completed', activeForm: null },
      { content: 'Test', status: 'in_progress', activeForm: 'Testing' }
    ])
  })

  it('keys a created task by the id its result names, and updates it by that id', () => {
    const tasks = new ClaudeTasks()
    tasks.call('TaskCreate', 'toolu_1', { subject: 'Write docs', activeForm: 'Writing docs' })
    tasks.result('toolu_1', { task: { id: '7', subject: 'Write docs' } })
    tasks.call('TaskUpdate', 'toolu_2', { taskId: '7', status: 'in_progress' })
    tasks.result('toolu_2', { success: true, taskId: '7' })
    expect(tasks.list()).toEqual([{ content: 'Write docs', status: 'in_progress', activeForm: 'Writing docs' }])
  })

  it('takes a listing as the whole truth, keeping how each step reads under way', () => {
    const tasks = new ClaudeTasks()
    tasks.call('TaskCreate', 'toolu_1', { subject: 'Old', activeForm: 'Doing old' })
    tasks.result('toolu_1', { task: { id: '1', subject: 'Old' } })
    tasks.call('TaskList', 'toolu_2', {})
    tasks.result('toolu_2', { tasks: [{ id: '1', subject: 'Old', status: 'completed' }, { id: '2', subject: 'New', status: 'pending' }] })
    expect(tasks.list()).toEqual([
      { content: 'Old', status: 'completed', activeForm: 'Doing old' },
      { content: 'New', status: 'pending', activeForm: null }
    ])
  })
})
