import { selectTask, useCore, useTaskBoardOpen } from '../core-store'
import { BoardIcon } from './icons'

// The way to the task board, which holds every task; the entry counts the ones someone is at.
export function TaskBoardEntry() {
  const open = useTaskBoardOpen()
  const running = useCore((s) => Object.values(s.tasks).filter((task) => task.status === 'running').length)
  const review = useCore((s) => Object.values(s.tasks).filter((task) => task.status === 'review').length)
  const counts = [running > 0 && `执行中 ${running}`, review > 0 && `待验收 ${review}`].filter(Boolean).join(' · ')
  return (
    <button type="button" className="inbox-entry sidebar-tasks" aria-current={open} onClick={() => selectTask(null)}>
      <BoardIcon />
      <span>任务</span>
      {counts && <span className="sidebar-tasks-counts">{counts}</span>}
    </button>
  )
}
