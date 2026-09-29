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

// How far along the list is, as a thin bar.
function ProgressBar({ todos }: { todos: readonly ChatTodo[] }) {
  const share = todos.length ? done(todos) / todos.length : 0
  return (
    <div className="chat-todos-bar" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done(todos)}>
      <span style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  )
}

// The step under way, as the agent phrases it while working on it.
export function currentTodo(todos: readonly ChatTodo[]): string | null {
  const step = todos.find((todo) => todo.status === 'in_progress')
  return step ? (step.activeForm ?? step.content) : null
}

const STATUS_LABEL: Record<ChatTodo['status'], string> = { completed: '已完成', in_progress: '进行中', pending: '未开始' }

// A step done is ticked and struck through, the one under way pulses, the rest wait as rings.
function TodoList({ todos }: { todos: readonly ChatTodo[] }) {
  return (
    <>
      <ProgressBar todos={todos} />
      <ul className="chat-todos">
        {todos.map((todo, index) => (
          <li key={index} data-status={todo.status}>
            <span className="chat-todo-mark" role="img" aria-label={STATUS_LABEL[todo.status]}>{todo.status === 'completed' && <CheckIcon />}</span>
            <span className="chat-todo-text">{todo.content}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

// Where a turn changed the agent's todo list: what it finished and started there, opening onto the
// list as that update left it.
export function ChatTodosLine({ item }: { item: TodosItem }) {
  const [open, setOpen] = useDisclosure(`todos:${itemKey(item)}`)
  const change = todoChange(useContext(TodoHistory).get(itemKey(item)) ?? null, item.todos)
  if (item.todos.length === 0) return null
  return (
    <div className="chat-todos-line">
      <button type="button" className="chat-fold-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        待办 {progress(item.todos)}
        {change && <span className="chat-todos-change">· {change}</span>}
      </button>
      {open && <div className="chat-todos-body"><TodoList todos={item.todos} /></div>}
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
        待办 {progress(todos)}{step && <span className="muted"> · {step}</span>}
      </button>
      {open && (
        <Popover label="agent 的待办" onClose={close}>
          <TodoList todos={todos} />
        </Popover>
      )}
    </span>
  )
}
