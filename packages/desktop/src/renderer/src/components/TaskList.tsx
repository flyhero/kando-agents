import { useCallback, useMemo, useRef, useState } from 'react'
import { AGENT_KINDS, shortTaskId, TASK_STATUSES, type Task } from '@kando/protocol'
import { openInbox, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { AGENT_LABEL, STATUS_LABEL } from '../labels'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { setPreference, TASK_GROUPS, TASK_SORTS, usePreferences, type Preferences } from '../preferences'
import { saveTaskText } from '../unsaved-edits'
import { ContextMenu, menuPoint, MenuRadioItem, MenuSubmenu, type MenuPoint } from './ContextMenu'
import { FilterIcon, InboxIcon, SlidersIcon } from './icons'
import { StatusIcon } from './StatusIcon'
import { hasTaskAlerts, TaskAlerts } from './TaskAlerts'
import { projectNames } from './ProjectPicker'
import { SidebarCollapseButton } from './SidebarCollapseButton'
import { SidebarSearchField, SidebarSearchToggle } from './SidebarSearch'
import { TaskContextMenu } from './TaskActions'
import { TitleEditor } from './TitleEditor'

type GroupBy = Preferences['taskGroup']
type SortBy = Preferences['taskSort']

const GROUP_LABEL: Record<GroupBy, string> = { none: '不分组', project: '项目', agent: '智能体', status: '任务状态' }
const SORT_LABEL: Record<SortBy, string> = { recent: '最近活动', created: '创建时间', title: '标题' }

const COMPARE: Record<SortBy, (a: Task, b: Task) => number> = {
  recent: (a, b) => b.updatedAt - a.updatedAt,
  // Preserve the old default: abandoned attempts stay below the useful history.
  created: (a, b) => Number(a.status === 'abandoned') - Number(b.status === 'abandoned') || b.createdAt - a.createdAt,
  title: (a, b) => a.title.localeCompare(b.title, 'zh-CN')
}

function groupOf(task: Task, by: Exclude<GroupBy, 'none'>): { label: string; rank: number } {
  switch (by) {
    case 'project':
      return { label: projectNames(task.repos.map((repo) => repo.path)), rank: task.repos.length > 0 ? 0 : 1 }
    case 'agent':
      return task.agent
        ? { label: AGENT_LABEL[task.agent], rank: AGENT_KINDS.indexOf(task.agent) }
        : { label: '未选择智能体', rank: AGENT_KINDS.length }
    case 'status':
      return { label: STATUS_LABEL[task.status], rank: TASK_STATUSES.indexOf(task.status) }
  }
}

type Group = { label: string | null; rank: number; items: Task[] }

function arrange(tasks: Task[], by: GroupBy, sort: SortBy): Group[] {
  const sorted = [...tasks].sort(COMPARE[sort])
  if (by === 'none') return [{ label: null, rank: 0, items: sorted }]
  const groups = new Map<string, Group>()
  for (const task of sorted) {
    const { label, rank } = groupOf(task, by)
    const group = groups.get(label) ?? { label, rank, items: [] }
    group.items.push(task)
    groups.set(label, group)
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || (a.label ?? '').localeCompare(b.label ?? '', 'zh-CN'))
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

function ViewMenu({ at, trigger, onClose }: { at: MenuPoint; trigger: HTMLElement | null; onClose: () => void }) {
  const groupBy = usePreferences((p) => p.taskGroup)
  const sortBy = usePreferences((p) => p.taskSort)
  const [open, setOpen] = useState<'group' | 'sort' | null>(null)
  const closeSubmenu = () => setOpen(null)
  return (
    <ContextMenu at={at} align="end" trigger={trigger} label="任务的分组和排序" onClose={onClose}>
      <MenuSubmenu label="分组方式" value={GROUP_LABEL[groupBy]} open={open === 'group'} onOpen={() => setOpen('group')} onClose={closeSubmenu}>
        {TASK_GROUPS.map((value) => (
          <MenuRadioItem key={value} label={GROUP_LABEL[value]} checked={value === groupBy} onSelect={() => {
            setPreference('taskGroup', value)
            onClose()
          }} />
        ))}
      </MenuSubmenu>
      <MenuSubmenu label="排序方式" value={SORT_LABEL[sortBy]} open={open === 'sort'} onOpen={() => setOpen('sort')} onClose={closeSubmenu}>
        {TASK_SORTS.map((value) => (
          <MenuRadioItem key={value} label={SORT_LABEL[value]} checked={value === sortBy} onSelect={() => {
            setPreference('taskSort', value)
            onClose()
          }} />
        ))}
      </MenuSubmenu>
    </ContextMenu>
  )
}

export function TaskList() {
  const [collapsed, setCollapsed] = useState(false)
  const tasks = useCore((s) => s.tasks)
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const showAll = usePreferences((p) => p.showAllTasks)
  const groupBy = usePreferences((p) => p.taskGroup)
  const sortBy = usePreferences((p) => p.taskSort)
  const sorted = useMemo(() => arrange(Object.values(tasks), groupBy, sortBy).flatMap((group) => group.items), [tasks, groupBy, sortBy])
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
  const groups = arrange(visible, groupBy, sortBy)
  const [viewAt, setViewAt] = useState<MenuPoint | null>(null)
  const closeView = useCallback(() => setViewAt(null), [])
  const viewButton = useRef<HTMLButtonElement>(null)

  const row = (task: Task) => {
    const waiting = waitingOn(task, tasks)
    // A chat task that has not started its work: planning, or holding the plan it saved.
    const planning = task.status === 'pending' && task.conversationId !== null
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
            {(waiting > 0 || planning || hasTaskAlerts(task)) && (
              <span className="task-row-tags">
                <TaskAlerts task={task} />
                {waiting > 0 && <span className="task-row-waiting">等待 {waiting} 个任务</span>}
                {planning && (
                  <span className="task-tag task-tag-refining">{task.plan && !task.plan.approved ? '计划已保存' : '规划中'}</span>
                )}
              </span>
            )}
          </button>
        )}
      </li>
    )
  }

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
          ref={viewButton}
          type="button"
          className="icon-button sidebar-tool"
          aria-label="分组和排序"
          aria-haspopup="menu"
          aria-expanded={viewAt !== null}
          data-tooltip="分组和排序"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setViewAt((current) => (current ? null : { x: box.right, y: box.bottom + 4 }))
          }}
        >
          <SlidersIcon />
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
        <SidebarSearchField label="搜索任务" placeholder="标题、来源编号或任务 id" query={query} onChange={setQuery} />
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
        groups.map((group) => group.label === null
          ? <ul key="all">{group.items.map(row)}</ul>
          : <section key={group.label} className="conversation-group" aria-label={group.label}>
            <h3 className="conversation-group-title">{group.label}<span className="count">{group.items.length}</span></h3>
            <ul>{group.items.map(row)}</ul>
          </section>)
      )}
      </div>
      {viewAt && <ViewMenu at={viewAt} trigger={viewButton.current} onClose={closeView} />}
      {menu && menuTask && (
        <TaskContextMenu task={menuTask} at={menu.at} onClose={closeMenu} onRename={() => setRenamingId(menuTask.id)} />
      )}
    </nav>
  )
}
