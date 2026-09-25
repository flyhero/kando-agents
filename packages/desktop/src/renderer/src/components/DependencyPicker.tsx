import { useCallback, useState, type KeyboardEvent } from 'react'
import { createsCycle, shortTaskId, type Task } from '@kando/protocol'
import { selectTask, useCore } from '../core-store'
import { STATUS_LABEL } from '../labels'
import { Popover } from './Popover'
import { StatusIcon } from './StatusIcon'

function TaskChip({ task, onRemove }: { task: Task; onRemove?: () => void }) {
  return (
    <span className="chip">
      <button
        type="button"
        className="chip-main"
        title={`${STATUS_LABEL[task.status]} · 点击打开`}
        onClick={() => selectTask(task.id)}
      >
        <StatusIcon status={task.status} decorative />
        <span className="chip-title">{task.title}</span>
      </button>
      {onRemove && (
        <button type="button" className="chip-remove" aria-label={`移除依赖 ${task.title}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  )
}

function DependencyMenu({
  candidates,
  looped,
  onAdd,
  onClose
}: {
  candidates: readonly Task[]
  looped: number
  onAdd: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? candidates.filter((task) => task.title.toLowerCase().includes(needle) || task.id.startsWith(needle))
    : candidates
  const add = (id: string) => {
    setQuery('')
    onAdd(id)
  }
  const onSearchKey = (event: KeyboardEvent) => {
    const first = shown[0]
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      add(first.id)
    }
  }

  return (
    <Popover label="添加依赖" onClose={onClose}>
      {candidates.length > 0 && (
        <input
          className="input menu-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="搜索标题或 id，回车添加第一个"
          aria-label="搜索任务"
        />
      )}
      {shown.length > 0 && (
        <ul className="menu-list">
          {shown.map((task) => (
            <li key={task.id} className="menu-row">
              <button type="button" className="menu-item" title={STATUS_LABEL[task.status]} onClick={() => add(task.id)}>
                <StatusIcon status={task.status} decorative />
                <span className="menu-item-title">{task.title}</span>
                <span className="menu-item-path mono">{shortTaskId(task.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown.length === 0 && (
        <p className="menu-note">{candidates.length > 0 ? '没有匹配的任务' : '没有其他可以依赖的任务'}</p>
      )}
      {looped > 0 && <p className="menu-note">已排除 {looped} 个会形成循环依赖的任务</p>}
    </Popover>
  )
}

// Controlled like ProjectPicker. `taskId` is null for a task not created yet,
// which nothing can depend on, so no candidate can close a loop.
export function DependencyPicker({
  taskId,
  dependsOn,
  onChange
}: {
  taskId: string | null
  dependsOn: readonly string[]
  onChange: (ids: string[]) => void
}) {
  const tasks = useCore((s) => s.tasks)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const lookup = (id: string) => tasks[id]?.dependsOn ?? []
  const dependencies = dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  // An abandoned task will never be done, so nothing can usefully wait on it.
  const others = Object.values(tasks)
    .filter((other) => other.id !== taskId && !dependsOn.includes(other.id) && other.status !== 'abandoned')
    .sort((a, b) => b.createdAt - a.createdAt)
  // Tasks that would close a loop are left out rather than offered and refused.
  const candidates = taskId ? others.filter((other) => !createsCycle(lookup, taskId, other.id)) : others

  return (
    <div className="chip-field">
      {dependencies.map((dependency) => (
        <TaskChip
          key={dependency.id}
          task={dependency}
          onRemove={() => onChange(dependsOn.filter((id) => id !== dependency.id))}
        />
      ))}
      <span className="menu-anchor">
        <button
          type="button"
          className="chip chip-add-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          ＋ 添加依赖
        </button>
        {/* Stays open after a pick so several dependencies can be added in a row. */}
        {open && (
          <DependencyMenu
            candidates={candidates}
            looped={others.length - candidates.length}
            onAdd={(id) => onChange([...dependsOn, id])}
            onClose={close}
          />
        )}
      </span>
    </div>
  )
}

export function TaskDependents({ dependents }: { dependents: readonly Task[] }) {
  return (
    <div className="chip-field">
      {dependents.map((dependent) => (
        <TaskChip key={dependent.id} task={dependent} />
      ))}
    </div>
  )
}
