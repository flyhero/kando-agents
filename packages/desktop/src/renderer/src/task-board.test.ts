import { describe, expect, it } from 'vitest'
import type { Task } from '@kando/protocol'
import { activeTasks, boardColumns, boardProjects, DONE_SHOWN, latestProjects, type BoardFilter } from './task-board'

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

const repo = (path: string) => ({ path, worktreePath: null, branch: null, startRef: null, start: null })
const all: BoardFilter = { query: '', project: null, agent: null }
const ids = (tasks: readonly Task[]) => tasks.map((each) => each.id)

describe('task board', () => {
  it('puts each task in its status column, abandoned ones only when asked', () => {
    const tasks = [task('a'), task('b', { status: 'running' }), task('c', { status: 'review' }), task('d', { status: 'abandoned' })]
    const columns = boardColumns(tasks, all, 'recent', { abandoned: false, allDone: false })
    expect(columns.map((column) => [column.status, ids(column.tasks)])).toEqual([
      ['pending', ['a']], ['running', ['b']], ['review', ['c']], ['done', []]
    ])
    expect(boardColumns(tasks, all, 'recent', { abandoned: true, allDone: false }).at(-1)).toMatchObject({ status: 'abandoned', total: 1 })
  })

  it('shows the latest done tasks and counts the rest', () => {
    const done = Array.from({ length: DONE_SHOWN + 3 }, (_, index) => task(`d${index}`, { status: 'done', updatedAt: index }))
    const [, , , cut] = boardColumns(done, all, 'recent', { abandoned: false, allDone: false })
    expect(cut).toMatchObject({ total: DONE_SHOWN + 3 })
    expect(cut?.tasks[0]?.id).toBe(`d${DONE_SHOWN + 2}`)
    expect(cut?.tasks).toHaveLength(DONE_SHOWN)
    expect(boardColumns(done, all, 'recent', { abandoned: false, allDone: true })[3]?.tasks).toHaveLength(DONE_SHOWN + 3)
  })

  it('narrows by text, project and agent together', () => {
    const tasks = [
      task('a', { title: 'Fix login', repos: [repo('/code/web')] }),
      task('b', { title: 'Fix build', repos: [repo('/code/api')], agent: 'codex' }),
      task('c', { title: 'Docs', repos: [repo('/code/web')], source: { provider: 'jira', instance: 'main', name: 'Jira', key: 'WEB-7', url: 'https://x/WEB-7' } })
    ]
    const pending = (filter: Partial<BoardFilter>) => ids(boardColumns(tasks, { ...all, ...filter }, 'title', { abandoned: false, allDone: false })[0]?.tasks ?? [])
    expect(pending({ query: 'fix' })).toEqual(['b', 'a'])
    expect(pending({ query: 'web-7' })).toEqual(['c'])
    expect(pending({ project: '/code/web' })).toEqual(['c', 'a'])
    expect(pending({ query: 'fix', agent: 'codex' })).toEqual(['b'])
  })

  it('lists the projects with the most tasks first, and the tasks someone is at by latest activity', () => {
    const tasks = [
      task('a', { repos: [repo('/code/web')], status: 'review', updatedAt: 1 }),
      task('b', { repos: [repo('/code/api'), repo('/code/web')], status: 'running', updatedAt: 2 }),
      task('c', { status: 'done', updatedAt: 3 })
    ]
    expect(boardProjects(tasks)).toEqual(['/code/web', '/code/api'])
    expect(ids(activeTasks(tasks))).toEqual(['b', 'a'])
  })

  it('writes a new task into the projects of the latest task that had any', () => {
    expect(latestProjects([])).toEqual([])
    expect(latestProjects([
      task('a', { repos: [repo('/code/web')], createdAt: 1 }),
      task('b', { repos: [repo('/code/api'), repo('/code/lib')], createdAt: 2 }),
      task('c', { createdAt: 3 })
    ])).toEqual(['/code/api', '/code/lib'])
  })
})
