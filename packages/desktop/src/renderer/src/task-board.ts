import { shortTaskId, type AgentKind, type Task, type TaskStatus } from '@kando/protocol'
import type { Preferences } from './preferences'

export type TaskSort = Preferences['taskSort']

// What the board is narrowed to; null shows every project or agent.
export type BoardFilter = { query: string; project: string | null; agent: AgentKind | null }

export type BoardColumn = { status: TaskStatus; tasks: Task[]; total: number }

// Abandoned attempts stay out of the way unless asked for.
const COLUMNS: readonly TaskStatus[] = ['pending', 'running', 'review', 'done']

// Done only grows; the rest is a click away.
export const DONE_SHOWN = 10

const COMPARE: Record<TaskSort, (a: Task, b: Task) => number> = {
  recent: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) => a.title.localeCompare(b.title, 'zh-CN')
}

// By title, issue key or the start of the task id, ignoring case.
export function matchesQuery(task: Task, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || [task.title, task.source?.key ?? '', shortTaskId(task.id)].some((text) => text.toLowerCase().includes(needle))
}

export function matchesFilter(task: Task, filter: BoardFilter): boolean {
  return matchesQuery(task, filter.query)
    && (filter.project === null || task.repos.some((repo) => repo.path === filter.project))
    && (filter.agent === null || task.agent === filter.agent)
}

// One column per status, in the order work moves; done cut to its latest unless all are asked for.
export function boardColumns(tasks: readonly Task[], filter: BoardFilter, sort: TaskSort, options: { abandoned: boolean; allDone: boolean }): BoardColumn[] {
  const shown = tasks.filter((task) => matchesFilter(task, filter)).sort(COMPARE[sort])
  const statuses = options.abandoned ? [...COLUMNS, 'abandoned' as const] : COLUMNS
  return statuses.map((status) => {
    const all = shown.filter((task) => task.status === status)
    const cut = status === 'done' && !options.allDone
    return { status, tasks: cut ? all.slice(0, DONE_SHOWN) : all, total: all.length }
  })
}

// Every project a task works in, for the filter: the ones with the most tasks first.
export function boardProjects(tasks: readonly Task[]): string[] {
  const counts = new Map<string, number>()
  for (const task of tasks) for (const repo of task.repos) counts.set(repo.path, (counts.get(repo.path) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path]) => path)
}

// The tasks someone is at: working, or handed in and waiting to be looked at.
export function activeTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.status === 'running' || task.status === 'review').sort(COMPARE.recent)
}

// A task written on the board goes where the latest one went, as its agent does (see defaultAgent).
export function latestProjects(tasks: readonly Task[]): string[] {
  const latest = [...tasks].sort((a, b) => b.createdAt - a.createdAt).find((task) => task.repos.length > 0)
  return latest ? latest.repos.map((repo) => repo.path) : []
}
