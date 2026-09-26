import { useCallback, useMemo, useState } from 'react'
import { shortTaskId, type Task } from '@kando/protocol'
import { openInbox, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { setPreference, usePreferences } from '../preferences'
import { saveTaskText } from '../unsaved-edits'
import { menuPoint, type MenuPoint } from './ContextMenu'
import { FilterIcon, InboxIcon } from './icons'
import { StatusIcon } from './StatusIcon'
import { hasTaskAlerts, TaskAlerts } from './TaskAlerts'
import { projectNames } from './ProjectPicker'
import { SidebarCollapseButton } from './SidebarCollapseButton'
import { SidebarSearchField, SidebarSearchToggle } from './SidebarSearch'
import { TaskContextMenu } from './TaskActions'
import { TitleEditor } from './TitleEditor'

// Creation order, not updatedAt: autosave while typing would keep reshuffling the list.
// Abandoned attempts sink to the bottom; they stay only as history.
function newestFirst(tasks: Record<string, Task>): Task[] {
  const abandoned = (task: Task) => (task.status === 'abandoned' ? 1 : 0)
  return Object.values(tasks).sort((a, b) => abandoned(a) - abandoned(b) || b.createdAt - a.createdAt)
}

// Under review still needs the user, so it stays in the unfinished list.
const isOpen = (task: Task) => task.status === 'pending' || task.status === 'running' || task.status === 'review'

// By title, issue key or the start of the task id, ignoring case.
function matches(task: Task, query: string): boolean {
  const needle = query.toLowerCase()
  return [task.title, task.source?.key ?? '', shortTaskId(task.id)].some((text) => text.toLowerCase().includes(needle))
}

// Only a pending task can be held up; the rest already ran.
function waitingOn(task: Task, tasks: Record<string, Task>): number {
  if (task.status !== 'pending') {
    return 0
  }
  return task.dependsOn.filter((id) => {
    const dependency = tasks[id]
    return dependency !== undefined && dependency.status !== 'done'
  }).length
}

// No task id: it is in the detail header and the row's right-click menu.
function taskMeta(task: Task): string {
  const parts: string[] = []
  if (task.source) parts.push(task.source.key)
  if (task.agent) parts.push(AGENT_LABEL[task.agent])
  if (task.repos.length > 0) parts.push(projectNames(task.repos.map((repo) => repo.path)))
  return parts.join(' · ')
}

export function TaskList() {
  const [collapsed, setCollapsed] = useState(false)
  const tasks = useCore((s) => s.tasks)
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const sorted = useMemo(() => newestFirst(tasks), [tasks])
  const showAll = usePreferences((p) => p.showAllTasks)
  // Null while the search box is closed. A search looks through every task: the one being
  // looked for is often long done, and the open-only filter would hide it.
  const [query, setQuery] = useState<string | null>(null)
  const searching = query !== null && query.trim() !== ''
  const visible = searching ? sorted.filter((task) => matches(task, query.trim())) : showAll ? sorted : sorted.filter(isOpen)
  const sources = useCore((s) => s.sources)
  const inboxes = useCore((s) => s.inboxes)
  const inboxOpen = useCore((s) => s.inboxOpen)
  const activeInboxes = Object.values(inboxes).filter((inbox) => inbox.active)
  const waitingIssues = activeInboxes.reduce((sum, inbox) => sum + inbox.items.length, 0)
  // Named after its source while there is only one, as it will be for most people.
  const only = activeInboxes.length === 1 ? sources?.find((source) => source.provider === activeInboxes[0]?.provider) : undefined
  const inboxLabel = only ? `${only.name} 收件箱` : '收件箱'
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTask = menu ? tasks[menu.id] : undefined

  return (
    <nav className="task-list" data-collapsed={collapsed} aria-label="任务列表">
      <header className="task-list-header">
        <SidebarCollapseButton label="任务" count={visible.length} collapsed={collapsed} controls="sidebar-tasks" onToggle={() => setCollapsed((value) => !value)} />
        <SidebarSearchToggle
          label="搜索任务"
          query={query}
          onToggle={() => {
            setQuery((current) => (current === null ? '' : null))
            setCollapsed(false)
          }}
        />
        <button
          type="button"
          className="icon-button sidebar-tool"
          aria-label="显示全部任务"
          aria-pressed={showAll}
          data-tooltip={showAll ? '只显示未完成的任务' : '显示全部任务'}
          onClick={() => setPreference('showAllTasks', !showAll)}
        >
          <FilterIcon />
        </button>
        <button
          type="button"
          className="icon-button task-list-add"
          data-tooltip={`新建任务 ${PRIMARY_KEY_LABEL}N`}
          aria-label="新建任务"
          onClick={() => setNewTaskOpen(true)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {query !== null && !collapsed && (
        <SidebarSearchField label="搜索任务" placeholder="标题、Jira 编号或任务 id" query={query} onChange={setQuery} />
      )}
      <div id="sidebar-tasks" className="sidebar-section-content" hidden={collapsed}>
      {!searching && activeInboxes.length > 0 && (
        <button type="button" className="inbox-entry" aria-current={section === 'tasks' && inboxOpen} onClick={openInbox}>
          <InboxIcon />
          <span>{inboxLabel}</span>
          {activeInboxes.some((inbox) => inbox.problem) ? (
            <span className="inbox-entry-alert" aria-label="同步失败">
              !
            </span>
          ) : (
            waitingIssues > 0 && <span className="inbox-entry-count">{waitingIssues}</span>
          )}
        </button>
      )}
      {sorted.length === 0 ? (
        <p className="task-list-empty">还没有任务，点右上角的 ＋ 新建一个。</p>
      ) : searching && visible.length === 0 ? (
        <p className="task-list-empty">没有找到匹配「{query.trim()}」的任务。</p>
      ) : visible.length === 0 ? (
        <p className="task-list-empty">
          没有未完成的任务。
          <button type="button" className="link-button" onClick={() => setPreference('showAllTasks', true)}>
            显示全部
          </button>
        </p>
      ) : (
        <ul>
          {visible.map((task) => {
            const waiting = waitingOn(task, tasks)
            const meta = taskMeta(task)
            return (
              <li key={task.id}>
                {renamingId === task.id ? (
                  <div className="task-row" data-renaming>
                    <StatusIcon status={task.status} />
                    <TitleEditor
                      title={task.title}
                      label="任务标题"
                      onSave={(title) => saveTaskText(task.id, 'title', title)}
                      onDone={() => setRenamingId(null)}
                    />
                    {meta && <span className="task-row-meta">{meta}</span>}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="task-row"
                    data-abandoned={task.status === 'abandoned' || undefined}
                    data-menu-open={menu?.id === task.id || undefined}
                    aria-current={section === 'tasks' && !inboxOpen && task.id === selectedId}
                    onClick={() => selectTask(task.id)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenu({ id: task.id, at: menuPoint(event) })
                    }}
                  >
                    <StatusIcon status={task.status} />
                    <span className="task-row-title">{task.title}</span>
                    {meta && <span className="task-row-meta">{meta}</span>}
                    {(waiting > 0 || task.refineSessionId || task.proposal || hasTaskAlerts(task)) && (
                      <span className="task-row-tags">
                        <TaskAlerts task={task} />
                        {waiting > 0 && <span className="task-row-waiting">等待 {waiting} 个任务</span>}
                        {task.refineSessionId && <span className="task-tag task-tag-refining">细化中</span>}
                        {task.proposal && <span className="task-tag task-tag-proposal">方案待确认</span>}
                      </span>
                    )}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      </div>
      {menu && menuTask && (
        <TaskContextMenu task={menuTask} at={menu.at} onClose={closeMenu} onRename={() => setRenamingId(menuTask.id)} />
      )}
    </nav>
  )
}
