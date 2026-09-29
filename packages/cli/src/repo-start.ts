import { START_HEAD, type StartNote, type TaskRepo } from '@kando/protocol'

const NOTE: Record<StartNote, string> = {
  'fetch-failed': '没能拉取最新的，用的是本地已有的',
  'no-remote-default': '没有 origin 的默认分支，用的是项目当前的分支'
}

// Where a repo's branch started, or where it is to start when the task picked that; empty when
// it starts from the default and has not yet.
export function repoStartText(repo: Pick<TaskRepo, 'startRef' | 'start'>): string {
  if (repo.start) return `从 ${repo.start.ref} ${repo.start.commit.slice(0, 7)} 拉出${repo.start.note ? `（${NOTE[repo.start.note]}）` : ''}`
  if (repo.startRef === START_HEAD) return '起点：项目当前的分支'
  if (repo.startRef) return `起点：${repo.startRef.replace(/^refs\/(heads|remotes)\//, '')}`
  return ''
}
