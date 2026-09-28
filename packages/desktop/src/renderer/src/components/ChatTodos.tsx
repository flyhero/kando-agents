import { useCallback, useState } from 'react'
import type { ChatItem, ChatTodo } from '@kando/protocol'
import { Popover } from './Popover'

type TodosItem = Extract<ChatItem, { kind: 'todos' }>

const MARK: Record<ChatTodo['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }

function progress(todos: readonly ChatTodo[]): string {
  return `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}`
}

// The step under way, as the agent phrases it while working on it.
export function currentTodo(todos: readonly ChatTodo[]): string | null {
  const step = todos.find((todo) => todo.status === 'in_progress')
  return step ? (step.activeForm ?? step.content) : null
}

function TodoList({ todos }: { todos: readonly ChatTodo[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((todo, index) => (
        <li key={index} data-status={todo.status}>
          <span className="chat-todo-mark" aria-hidden="true">{MARK[todo.status]}</span>
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  )
}

// Where a turn changed the agent's todo list: the list as that turn left it, folded.
export function ChatTodosLine({ item }: { item: TodosItem }) {
  if (item.todos.length === 0) return null
  return (
    <details className="chat-todos-line">
      <summary className="muted">待办 {progress(item.todos)}</summary>
      <TodoList todos={item.todos} />
    </details>
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
