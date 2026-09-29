import { START_HEAD, type RepoStartOptions, type StartNote, type TaskRepo } from '@kando/protocol'

export const START_NOTE_TEXT: Record<StartNote, string> = {
  'fetch-failed': '没能拉取最新的，用的是本地已有的',
  'no-remote-default': '没有 origin 的默认分支，从项目当前的分支拉出'
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

// What the branch starts from when nothing is picked, in words; `taskOf` names a dependency's
// branch by its task's title.
export function fallbackText(option: RepoStartOptions, taskOf: (branch: string) => string | undefined): { ref: string; says: string } {
  if (!option.fallback) return { ref: option.current ?? START_HEAD, says: '没有 origin 的默认分支，用项目当前的分支' }
  const ref = shortRef(option.fallback)
  if (!option.stacked) return { ref, says: 'origin 的默认分支，开始前先拉取' }
  const title = taskOf(ref)
  return { ref, says: title ? `依赖任务「${title}」的分支` : '依赖任务的分支' }
}

// What the picker button shows: the branch, and a word on where it comes from.
export function pickedText(repo: Pick<TaskRepo, 'startRef'>, option: RepoStartOptions, taskOf: (branch: string) => string | undefined): { ref: string; says: string | null } {
  if (repo.startRef === null) return { ref: fallbackText(option, taskOf).ref, says: '默认' }
  if (repo.startRef === START_HEAD) return { ref: option.current ?? START_HEAD, says: '项目当前的分支' }
  return { ref: shortRef(repo.startRef), says: repo.startRef.startsWith('refs/remotes/') ? '开始前先拉取' : null }
}
