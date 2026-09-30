import { createContext, useCallback, useContext, useState } from 'react'
import type { ChatItem, ChatTodo } from '@kando/protocol'
import { useDisclosure } from '../chat-disclosure'
import { itemKey, todoChange } from '../chat-state'
import { CheckIcon, ChevronRightIcon } from './icons'
import { Popover } from './Popover'

type TodosItem = Extract<ChatItem, { kind: 'todos' }>

// Each update of the todo list's list before it, to say what the update changed.
export const TodoHistory = createContext<ReadonlyMap<string, ChatTodo[] | null>>(new Map())

function done(todos: readonly ChatTodo[]): number {
  return todos.filter((todo) => todo.status === 'completed').length
}

function progress(todos: readonly ChatTodo[]): string {
  return `${done(todos)}/${todos.length}`
}

// How far along the list is, as a ring: filling clockwise from the top, green once complete.
const RING_R = 6
const RING_LENGTH = 2 * Math.PI * RING_R

function ProgressRing({ todos }: { todos: readonly ChatTodo[] }) {
  const finished = done(todos)
  const share = todos.length ? finished / todos.length : 0
  return (
    <svg
      className="chat-todos-ring"
      viewBox="0 0 14 14"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={todos.length}
      aria-valuenow={finished}
      data-done={(todos.length > 0 && finished === todos.length) || undefined}
    >
      <circle className="chat-todos-ring-track" cx="7" cy="7" r={RING_R} />
      <circle className="chat-todos-ring-fill" cx="7" cy="7" r={RING_R} strokeDasharray={RING_LENGTH} strokeDashoffset={RING_LENGTH * (1 - share)} />
    </svg>
  )
}

// The list in a line: the step under way, else the last one finished, else that it is all done.
type TodoSummary = { state: 'inProgress' | 'completedStep' | 'allDone' | 'idle'; label: string; detail: string | null }

export function todoSummary(todos: readonly ChatTodo[]): TodoSummary {
  const finished = done(todos)
  const step = todos.find((todo) => todo.status === 'in_progress')
  if (step) return { state: 'inProgress', label: '当前步骤', detail: step.activeForm ?? step.content }
  if (todos.length > 0 && finished === todos.length) return { state: 'allDone', label: '全部步骤已完成', detail: null }
  const last = [...todos].reverse().find((todo) => todo.status === 'completed')
  if (last) return { state: 'completedStep', label: '已完成', detail: last.content }
  return { state: 'idle', label: '待办', detail: null }
}

function SummaryText({ summary }: { summary: TodoSummary }) {
  return (
    <span className="chat-todos-label">
      {summary.label}
      {summary.detail && <>: <b>{summary.detail}</b></>}
    </span>
  )
}

// The arrow that marks the step under way.
function ArrowMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
      <path d="m13 8 4 4-4 4" />
    </svg>
  )
}

// The step under way, as the agent phrases it while working on it.
export function currentTodo(todos: readonly ChatTodo[]): string | null {
  const step = todos.find((todo) => todo.status === 'in_progress')
  return step ? (step.activeForm ?? step.content) : null
}

const STATUS_LABEL: Record<ChatTodo['status'], string> = { completed: '已完成', in_progress: '进行中', pending: '未开始' }

// A step done is ticked and struck through, the one under way is arrowed and read in its active
// form, the rest wait as rings.
function TodoList({ todos }: { todos: readonly ChatTodo[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((todo, index) => (
        <li key={index} data-status={todo.status}>
          <span className="chat-todo-mark" role="img" aria-label={STATUS_LABEL[todo.status]}>
            {todo.status === 'completed' ? <CheckIcon /> : todo.status === 'in_progress' ? <ArrowMark /> : null}
          </span>
          <span className="chat-todo-text">{todo.status === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}</span>
        </li>
      ))}
    </ul>
  )
}

// Above the open list: the summary again, with the count at the end.
function TodoPanel({ todos }: { todos: readonly ChatTodo[] }) {
  const summary = todoSummary(todos)
  return (
    <div className="chat-todos-body">
      <div className="chat-todos-head" data-state={summary.state}>
        {summary.state === 'inProgress' ? <ArrowMark /> : <CheckIcon />}
        <SummaryText summary={summary} />
        <span className="chat-todos-count">{progress(todos)}</span>
      </div>
      <TodoList todos={todos} />
    </div>
  )
}

// Where a turn changed the agent's todo list: what it finished and started there, opening onto the
// list as that update left it.
export function ChatTodosLine({ item }: { item: TodosItem }) {
  const [open, setOpen] = useDisclosure(`todos:${itemKey(item)}`)
  const change = todoChange(useContext(TodoHistory).get(itemKey(item)) ?? null, item.todos)
  if (item.todos.length === 0) return null
  const summary = todoSummary(item.todos)
  return (
    <div className="chat-todos-line">
      <button type="button" className="chat-tool-row" aria-expanded={open} title={change ?? undefined} onClick={() => setOpen(!open)}>
        <ProgressRing todos={item.todos} />
        {summary.state !== 'allDone' && <span className="chat-todos-count">{progress(item.todos)}</span>}
        <SummaryText summary={summary} />
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      {open && <TodoPanel todos={item.todos} />}
    </div>
  )
}

// In the dock while steps remain: how far along the list is, and a click for the whole list.
export function ChatTodosChip({ todos }: { todos: readonly ChatTodo[] }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  if (todos.length === 0 || todos.every((todo) => todo.status === 'completed')) return null
  const step = currentTodo(todos)
  return (
    <span className="menu-anchor chat-todos-anchor">
      <button
        type="button"
        className="chat-changes"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ProgressRing todos={todos} />
        <span className="mono">{progress(todos)}</span>
        {step && <span className="muted">{step}</span>}
      </button>
      {open && (
        <Popover label="agent 的待办" onClose={close}>
          <TodoList todos={todos} />
        </Popover>
      )}
    </span>
  )
}
