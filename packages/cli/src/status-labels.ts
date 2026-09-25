import type { TaskStatus } from '@kando/protocol'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '未执行',
  running: '执行中',
  done: '已执行',
  abandoned: '已废弃'
}
