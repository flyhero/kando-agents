import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { AGENT_KINDS, type AgentKind, type Task } from '@kando/protocol'
import { timeAgo } from '../conversation-state'
import { openInbox, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { AGENT_LABEL, STATUS_LABEL } from '../labels'
import { setPreference, TASK_SORTS, usePreferences } from '../preferences'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { boardColumns, boardProjects, type BoardColumn, type BoardFilter, type TaskSort } from '../task-board'
import { waitingOn } from '../task-waiting'
import { saveTaskText } from '../unsaved-edits'
import { ContextMenu, menuPoint, MenuRadioItem, type MenuPoint } from './ContextMenu'
import { AgentIcon, ChevronDownIcon, InboxIcon } from './icons'
import { projectName, projectNames } from './ProjectPicker'
import { StatusIcon } from './StatusIcon'
import { cardAction, TaskContextMenu, useChatTurn } from './TaskActions'
import { TaskAlerts } from './TaskAlerts'
import { openQuickAdd, TaskQuickAdd } from './TaskQuickAdd'
import { TitleEditor } from './TitleEditor'

// The way back from a task to the board, at the start of its header; Esc goes there too.
export function BoardCrumb() {
  return (
    <span className="board-crumb">
      <button type="button" className="board-crumb-link" data-tooltip="回到任务看板 Esc" onClick={() => selectTask(null)}>任务</button>
      <span className="board-crumb-sep" aria-hidden="true">/</span>
    </span>
  )
}

const SORT_LABEL: Record<TaskSort, string> = { recent: '最近活动', created: '创建时间', title: '标题' }

// Kept while a task is open, so going back finds the board as it was left.
const useBoardFilter = create<BoardFilter & { allDone: boolean }>(() => ({ query: '', project: null, agent: null, allDone: false }))

// The tasks, one column per status. Each card offers the step that moves its task on; the rest is
// in the task itself, which a click opens.
export function TaskBoard() {
  const tasks = useCore((s) => s.tasks)
  const filter = useBoardFilter()
  const sort = usePreferences((p) => p.taskSort)
  const abandoned = usePreferences((p) => p.showAbandonedTasks)
  const list = useMemo(() => Object.values(tasks), [tasks])
  const columns = useMemo(
    () => boardColumns(list, filter, sort, { abandoned, allDone: filter.allDone }),
    [list, filter, sort, abandoned]
  )
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTask = menu ? tasks[menu.id] : undefined
  const narrowed = filter.query.trim() !== '' || filter.project !== null || filter.agent !== null
  const now = Date.now()
  // The task just written down, lit for a moment where it lands.
  const [freshId, setFreshId] = useState<string | null>(null)

  // N writes a task down, unless it is being typed somewhere or a dialog or menu is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="menu"], dialog')) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      openQuickAdd()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section className="task-board" aria-label="任务">
      <header className="task-board-header">
        <h2>任务</h2>
        <input
          className="input task-board-search"
          type="search"
          aria-label="搜索任务"
          placeholder="标题、来源编号或任务 id"
          value={filter.query}
          onChange={(event) => useBoardFilter.setState({ query: event.target.value })}
        />
        <ProjectFilter tasks={list} value={filter.project} />
        <AgentFilter tasks={list} value={filter.agent} />
        <span className="task-board-spacer" />
        <InboxButton />
        <button
          type="button"
          className="task-board-chip"
          aria-pressed={abandoned}
          onClick={() => setPreference('showAbandonedTasks', !abandoned)}
        >
          已废弃
        </button>
        <SortButton value={sort} />
        <button type="button" className="button primary task-board-new" onClick={() => setNewTaskOpen(true)}>
          新建任务 <span className="task-board-key">{PRIMARY_KEY_LABEL}N</span>
        </button>
      </header>
      <div className="task-board-columns">
        {columns.map((column) => (
          <Column key={column.status} column={column} narrowed={narrowed} top={column.status === 'pending' && <TaskQuickAdd onCreated={setFreshId} />}>
            {column.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                tasks={tasks}
                now={now}
                fresh={freshId === task.id}
                renaming={renamingId === task.id}
                menuOpen={menu?.id === task.id}
                onRenamed={() => setRenamingId(null)}
                onMenu={(at) => setMenu({ id: task.id, at })}
              />
            ))}
          </Column>
        ))}
      </div>
      {menu && menuTask && (
        <TaskContextMenu task={menuTask} at={menu.at} onClose={closeMenu} onRename={() => setRenamingId(menuTask.id)} />
      )}
    </section>
  )
}

function Column({ column, narrowed, top, children }: { column: BoardColumn; narrowed: boolean; top?: ReactNode; children: ReactNode }) {
  const hidden = column.total - column.tasks.length
  return (
    <section className="task-board-column" aria-label={STATUS_LABEL[column.status]} data-status={column.status}>
      <h3 className="task-board-column-title">
        <StatusIcon status={column.status} decorative />
        <span>{STATUS_LABEL[column.status]}</span>
        <span className="count">{column.total}</span>
      </h3>
      {top}
      {column.total === 0 ? !top && <p className="task-board-column-empty">{narrowed ? '没有匹配的任务' : '空'}</p> : children}
      {hidden > 0 && (
        <button type="button" className="task-board-more" onClick={() => useBoardFilter.setState({ allDone: true })}>
          显示更早的 {hidden} 个
        </button>
      )}
    </section>
  )
}

function TaskCard({ task, tasks, now, fresh, renaming, menuOpen, onRenamed, onMenu }: {
  task: Task
  tasks: Readonly<Record<string, Task>>
  now: number
  fresh: boolean
  renaming: boolean
  menuOpen: boolean
  onRenamed: () => void
  onMenu: (at: MenuPoint) => void
}) {
  const turn = useChatTurn(task)
  const dependencies = task.dependsOn.map((id) => tasks[id]).filter((dependency) => dependency !== undefined)
  const action = cardAction(task, dependencies, turn)
  // A chat task that has not started its work: planning, or holding the plan it saved.
  const planning = task.status === 'pending' && task.conversationId !== null
  const agent = task.agent ? AGENT_LABEL[task.agent] : 'Agent'
  return (
    <article
      className="task-card"
      data-menu-open={menuOpen || undefined}
      data-fresh={fresh || undefined}
      data-abandoned={task.status === 'abandoned' || undefined}
      onClick={(event) => {
        if (!renaming && !(event.target instanceof Element && event.target.closest('.task-card-action'))) selectTask(task.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(menuPoint(event))
      }}
    >
      {renaming ? (
        <TitleEditor title={task.title} label="任务标题" onSave={(title) => saveTaskText(task.id, 'title', title)} onDone={onRenamed} />
      ) : (
        <button type="button" className="task-card-title" title={task.title}>{task.title}</button>
      )}
      {(planning || task.source || waitingOn(task, tasks) > 0) && (
        <span className="task-card-tags">
          {task.source && <span className="task-tag mono">{task.source.key}</span>}
          {planning && <span className="task-tag task-tag-refining">{task.plan && !task.plan.approved ? '计划已保存' : '规划中'}</span>}
          {waitingOn(task, tasks) > 0 && <span className="task-tag">等待依赖</span>}
        </span>
      )}
      <TaskAlerts task={task} />
      {turn === 'running' && <span className="task-card-activity" data-turn="running">{agent} 工作中</span>}
      {turn === 'awaiting' && <span className="task-card-activity" data-turn="awaiting">等你确认或回答</span>}
      <span className="task-card-meta">
        <span className="task-card-agent" title={agent}><AgentIcon agent={task.agent} /></span>
        <span className="task-card-project">{projectNames(task.repos.map((repo) => repo.path))}</span>
        <span className="task-card-time">{timeAgo(task.updatedAt, now)}</span>
      </span>
      {action && (
        <span className="task-card-action">
          <button
            type="button"
            className="button"
            aria-disabled={action.reason !== null}
            data-tooltip={action.reason ? `还不能${action.label}：${action.reason}` : undefined}
            onClick={() => {
              if (!action.reason) action.run()
            }}
          >
            {action.label}
          </button>
        </span>
      )}
    </article>
  )
}

// A chip that opens a list of choices, as the filters and the sort are.
function ChoiceMenu<T>({ label, value, text, choices, describe, onPick, pressed }: {
  label: string
  value: T
  // What the chip says, when it is more than the choice's name.
  text?: string
  choices: readonly T[]
  describe: (choice: T) => string
  onPick: (choice: T) => void
  pressed: boolean
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  return (
    <>
      <button
        ref={button}
        type="button"
        className="task-board-chip"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-pressed={pressed}
        onClick={() => {
          const box = button.current?.getBoundingClientRect()
          if (box) setAt((current) => (current ? null : { x: box.left, y: box.bottom + 4 }))
        }}
      >
        {text ?? describe(value)}
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} trigger={button.current} label={label} onClose={close}>
          {choices.map((choice, index) => (
            <MenuRadioItem
              key={index}
              label={describe(choice)}
              checked={choice === value}
              onSelect={() => {
                onPick(choice)
                close()
              }}
            />
          ))}
        </ContextMenu>
      )}
    </>
  )
}

function ProjectFilter({ tasks, value }: { tasks: readonly Task[]; value: string | null }) {
  const projects = useMemo(() => boardProjects(tasks), [tasks])
  if (projects.length < 2 && value === null) return null
  const describe = (project: string | null) => (project === null ? '全部项目' : projectName(project))
  return (
    <ChoiceMenu
      label="按项目筛选"
      value={value}
      choices={[null, ...projects]}
      describe={describe}
      pressed={value !== null}
      onPick={(project) => useBoardFilter.setState({ project })}
    />
  )
}

function AgentFilter({ tasks, value }: { tasks: readonly Task[]; value: AgentKind | null }) {
  const used = AGENT_KINDS.filter((agent) => tasks.some((task) => task.agent === agent))
  if (used.length < 2 && value === null) return null
  const describe = (agent: AgentKind | null) => (agent === null ? '全部 Agent' : AGENT_LABEL[agent])
  return (
    <ChoiceMenu
      label="按 Agent 筛选"
      value={value}
      choices={[null, ...used]}
      describe={describe}
      pressed={value !== null}
      onPick={(agent) => useBoardFilter.setState({ agent })}
    />
  )
}

function SortButton({ value }: { value: TaskSort }) {
  return (
    <ChoiceMenu
      label="排序方式"
      value={value}
      text={`排序：${SORT_LABEL[value]}`}
      choices={TASK_SORTS}
      describe={(sort) => SORT_LABEL[sort]}
      pressed={false}
      onPick={(sort) => setPreference('taskSort', sort)}
    />
  )
}

// Issues waiting to come in as tasks; a failed sync shows in place of the count.
function InboxButton() {
  const sources = useCore((s) => s.sources)
  const inboxes = useCore((s) => s.inboxes)
  const active = Object.values(inboxes).filter((inbox) => inbox.active)
  if (active.length === 0) return null
  const waiting = active.reduce((sum, inbox) => sum + inbox.items.length, 0)
  // Named after its source while there is only one, as it will be for most people.
  const only = active.length === 1 ? sources?.find((source) => source.provider === active[0]?.provider) : undefined
  return (
    <button type="button" className="task-board-chip" onClick={openInbox}>
      <InboxIcon />
      {only ? `${only.name} 收件箱` : '收件箱'}
      {active.some((inbox) => inbox.problem)
        ? <span className="inbox-entry-alert" aria-label="同步失败">!</span>
        : waiting > 0 && <span className="inbox-entry-count">{waiting}</span>}
    </button>
  )
}
