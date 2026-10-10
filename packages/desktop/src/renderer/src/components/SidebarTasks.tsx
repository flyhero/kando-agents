import { useCallback, useMemo, useState } from 'react'
import type { Task } from '@kando/protocol'
import { selectTask, setNewTaskOpen, useCore, useTaskBoardOpen } from '../core-store'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { activeTasks } from '../task-board'
import { saveTaskText } from '../unsaved-edits'
import { menuPoint, type MenuPoint } from './ContextMenu'
import { BoardIcon } from './icons'
import { StatusIcon } from './StatusIcon'
import { TaskContextMenu } from './TaskActions'
import { hasTaskAlerts, TaskAlerts } from './TaskAlerts'
import { TitleEditor } from './TitleEditor'

// The sidebar's tasks: the way to the board, which holds them all, and under it the ones someone is
// at, to go between them in one click. They belong to the board, so they hang from it.
export function SidebarTasks() {
  const open = useTaskBoardOpen()
  const tasks = useCore((s) => s.tasks)
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const active = useMemo(() => activeTasks(Object.values(tasks)), [tasks])
  const running = active.filter((task) => task.status === 'running').length
  const counts = [running > 0 && `执行中 ${running}`, active.length > running && `待验收 ${active.length - running}`].filter(Boolean).join(' · ')
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTask = menu ? tasks[menu.id] : undefined

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
    <nav className="sidebar-tasks" aria-label="任务">
      <div className="sidebar-tasks-entry">
        <button type="button" className="inbox-entry" aria-current={open} onClick={() => selectTask(null)}>
          <BoardIcon />
          <span>任务</span>
          {counts && <span className="sidebar-tasks-counts">{counts}</span>}
        </button>
        <button
          type="button"
          className="icon-button sidebar-tasks-add"
          aria-label="新建任务"
          data-tooltip={`新建任务 ${PRIMARY_KEY_LABEL}N`}
          onClick={() => setNewTaskOpen(true)}
        >
          ＋
        </button>
      </div>
      {active.length > 0 && <ul className="sidebar-tasks-active" aria-label="进行中的任务">{active.map(row)}</ul>}
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
