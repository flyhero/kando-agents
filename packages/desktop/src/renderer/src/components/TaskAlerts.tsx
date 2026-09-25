import type { Task } from '@kando/protocol'

// A run's exit only matters once it has ended, and a clean exit needs no word.
function oddExit(task: Task): Task['lastExit'] {
  const exit = task.status === 'done' ? task.lastExit : null
  return exit && exit.code !== 0 ? exit : null
}

export function hasTaskAlerts(task: Task): boolean {
  return task.awaitingInput || oddExit(task) !== null
}

// What needs the user's eye beyond the status: an agent waiting on them, a run that ended oddly.
export function TaskAlerts({ task }: { task: Task }) {
  const exit = oddExit(task)
  return (
    <>
      {task.awaitingInput && (
        <span className="task-tag task-tag-awaiting" title="agent 这一轮做完了，在终端里等你回复或确认">
          等你回复
        </span>
      )}
      {exit &&
        (exit.code === null ? (
          <span className="task-tag task-tag-exit" title="Kando 重新连上时，这次执行的会话已经不在了，不知道它是怎么结束的">
            已中断
          </span>
        ) : (
          <span className="task-tag task-tag-exit" title={`agent 以退出码 ${exit.code} 结束，可以打开终端看看发生了什么`}>
            异常退出 {exit.code}
          </span>
        ))}
    </>
  )
}
