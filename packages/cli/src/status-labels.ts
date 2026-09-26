import type { TaskStatus } from '@kando/protocol'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '未执行',
  running: '执行中',
  review: '待验收',
  done: '已完成',
  abandoned: '已废弃'
}
