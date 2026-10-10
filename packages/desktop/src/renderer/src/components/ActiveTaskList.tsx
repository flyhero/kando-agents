import { useCallback, useMemo, useState } from 'react'
import type { Task } from '@kando/protocol'
import { selectTask, useCore } from '../core-store'
import { activeTasks } from '../task-board'
import { saveTaskText } from '../unsaved-edits'
import { menuPoint, type MenuPoint } from './ContextMenu'
import { ListIcon } from './icons'
import { StatusIcon } from './StatusIcon'
import { SidebarCollapseButton } from './SidebarCollapseButton'
import { TaskContextMenu } from './TaskActions'
import { hasTaskAlerts, TaskAlerts } from './TaskAlerts'
import { TitleEditor } from './TitleEditor'

// The tasks someone is at, for going between them in one click; every other task is on the board.
export function ActiveTaskList() {
  const [collapsed, setCollapsed] = useState(false)
  const tasks = useCore((s) => s.tasks)
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const active = useMemo(() => activeTasks(Object.values(tasks)), [tasks])
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTask = menu ? tasks[menu.id] : undefined
  if (active.length === 0) return null

  const row = (task: Task) => (
    <li key={task.id}>
      {renamingId === task.id ? (
        <div className="task-row" data-renaming>
          <StatusIcon status={task.status} />
          <TitleEditor title={task.title} label="任务标题" onSave={(title) => saveTaskText(task.id, 'title', title)} onDone={() => setRenamingId(null)} />
        </div>
      ) : (
        <button
          type="button"
          className="task-row"
          data-menu-open={menu?.id === task.id || undefined}
          aria-current={section === 'tasks' && task.id === selectedId}
          onClick={() => selectTask(task.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ id: task.id, at: menuPoint(event) })
          }}
        >
          <StatusIcon status={task.status} />
          <span className="task-row-title">{task.title}</span>
          <AwaitingDot task={task} />
          {hasTaskAlerts(task) && <span className="task-row-tags"><TaskAlerts task={task} /></span>}
        </button>
      )}
    </li>
  )

  return (
    <nav className="task-list active-task-list" data-collapsed={collapsed} aria-label="进行中的任务">
      <header className="task-list-header">
        <SidebarCollapseButton icon={<ListIcon />} label="进行中" count={active.length} collapsed={collapsed} controls="sidebar-active-tasks" onToggle={() => setCollapsed((value) => !value)} />
      </header>
      <div id="sidebar-active-tasks" className="sidebar-section-content" hidden={collapsed}>
        <ul>{active.map(row)}</ul>
      </div>
      {menu && menuTask && (
        <TaskContextMenu task={menuTask} at={menu.at} onClose={closeMenu} onRename={() => setRenamingId(menuTask.id)} />
      )}
    </nav>
  )
}

// The task's agent waits for the user: a question or a permission.
function AwaitingDot({ task }: { task: Task }) {
  const awaiting = useCore((s) => {
    const conversation = task.conversationId ? s.conversations[task.conversationId] : undefined
    return conversation?.sessionId != null && conversation.chat?.turn === 'awaiting'
  })
  return awaiting ? <span className="active-task-awaiting" role="img" aria-label="等你确认或回答" title="等你确认或回答" /> : null
}
