import type { Task } from '@kando/protocol'

// How many of a task's dependencies it still waits on. Only a pending task can be held up, the
// rest already ran; and only an accepted (done) dependency counts, as `startKind` has it.
export function waitingOn(task: Task, tasks: Readonly<Record<string, Task>>): number {
  if (task.status !== 'pending') {
    return 0
  }
  return task.dependsOn.filter((id) => {
    const dependency = tasks[id]
    return dependency !== undefined && dependency.status !== 'done'
  }).length
}
