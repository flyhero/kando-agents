import path from 'node:path'
import {
  PROPOSE_DETAILS_TOOL,
  READ_TASK_TOOL,
  shortTaskId,
  taskPrompt,
  untrustedSource,
  type AgentKind,
  type SnapshotImagePath,
  type Task,
  type TaskStatus
} from '@kando/protocol'
import type { RefineWorkspace, Workspace } from './workspace'

// Relative when the folder sits under the agent's cwd, absolute otherwise.
function where(workspace: Workspace, dir: string): string {
  const relative = path.relative(workspace.cwd, dir)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `${relative}/` : dir
}

function workspaceSection(workspace: Workspace): string | null {
  if (!workspace.multi) {
    return null
  }
  return [
    '本任务涉及多个项目，当前目录下每个子目录是一个 Git 仓库的独立 worktree：',
    ...workspace.entries.map(
      (entry) => `- ${where(workspace, entry.dir)} ← ${entry.source}${entry.branch ? `（分支 ${entry.branch}）` : ''}`
    )
  ].join('\n')
}

type Dependency = Pick<Task, 'id' | 'title' | 'repos' | 'status' | 'details'>

const STATUS_TEXT: Record<TaskStatus, string> = { pending: '未执行', running: '执行中', done: '已执行', abandoned: '已废弃' }

// Plans of unfinished dependencies go inline up to this much each; the agent reads the
// rest (and anything else it wants) through the read tool.
const PLAN_EXCERPT_LIMIT = 2_000

function branchNotes(workspace: Workspace, dependency: Pick<Task, 'repos'>): string[] {
  const stackedOn = new Set(workspace.entries.flatMap((entry) => (entry.base ? [entry.base] : [])))
  return dependency.repos.flatMap((repo) =>
    repo.branch ? [`${repo.branch}${stackedOn.has(repo.branch) ? '，本任务的分支从它拉出' : ''}`] : []
  )
}

// Running needs only where the earlier work lives; the refined details already say the rest.
function dependencySection(workspace: Workspace, dependencies: readonly Pick<Task, 'id' | 'title' | 'repos'>[]): string | null {
  if (dependencies.length === 0) {
    return null
  }
  return [
    '本任务依赖以下任务：',
    ...dependencies.map((dependency) => {
      const branches = branchNotes(workspace, dependency)
      return `- ${shortTaskId(dependency.id)} ${dependency.title}${branches.length ? `（${branches.join('；')}）` : ''}`
    })
  ].join('\n')
}

// A finished dependency is described by its code, so the agent only needs to know
// whether that code is in front of it. An unfinished one has only its plan.
function dependencyLine(landed: ReadonlySet<string>, dependency: Dependency): string {
  const label = `${shortTaskId(dependency.id)}「${dependency.title}」`
  if (dependency.status !== 'done') {
    return `- ${label}：${STATUS_TEXT[dependency.status]}，还没有代码，只有下面的计划`
  }
  const branches = dependency.repos.flatMap((repo) => (repo.branch ? [repo.branch] : []))
  if (branches.length === 0) {
    const folders = dependency.repos.map((repo) => repo.path).join('、')
    return `- ${label}：已执行，直接改在了 ${folders} 里，读那里的代码即可`
  }
  const here = branches.filter((branch) => landed.has(branch))
  const elsewhere = branches.filter((branch) => !landed.has(branch))
  const notes = [
    ...(here.length ? ['改动已在当前代码里，直接读代码即可'] : []),
    ...(elsewhere.length
      ? [`分支 ${elsewhere.join('、')} 上的改动还没进当前代码，可以用 git log / git diff / git show 查看`]
      : [])
  ]
  return `- ${label}：已执行，${notes.join('；')}`
}

// Refining reads the repos where they are, so give the agent every path.
function codeSection(workspace: RefineWorkspace): string {
  return [
    '本任务涉及的代码（只读查看，不要修改）：',
    ...workspace.dirs.map((dir) => `- ${dir}${dir === workspace.cwd ? '（当前目录）' : ''}`)
  ].join('\n')
}

// The images a prompt can point at, already resolved to files on this machine (null: gone).
export type PromptImage = { label: string; path: string | null }
export type PromptImages = { attached: readonly PromptImage[]; source: readonly SnapshotImagePath[] }
const NO_IMAGES: PromptImages = { attached: [], source: [] }

// The user's own images: part of the task, so the agent looks at them before starting.
function imageSection(images: readonly PromptImage[]): string | null {
  if (images.length === 0) {
    return null
  }
  return [
    `任务附了 ${images.length} 张图片，开始前先用读取文件的工具查看（如果它们已经附在这条消息里，直接看即可）：`,
    ...images.map((image) => `- ${image.label}：${image.path ?? '（图片已丢失）'}`)
  ].join('\n')
}

// Where an imported task came from, and the issue's own text and images fenced off as untrusted.
function sourceSection(task: Pick<Task, 'source' | 'sourceSnapshot'>, images: PromptImages): string | null {
  return task.source ? untrustedSource(task.source, task.sourceSnapshot, images.source) : null
}

type Predecessor = Pick<Task, 'id' | 'title' | 'repos' | 'abandonReason'>

// A redo starts clean, but the abandoned attempt is worth a look for what not to repeat.
function predecessorSection(predecessor: Predecessor | null): string | null {
  if (!predecessor) {
    return null
  }
  const branches = predecessor.repos.flatMap((repo) => (repo.branch ? [repo.branch] : []))
  return [
    `这个任务是重做：上一次尝试 ${shortTaskId(predecessor.id)}「${predecessor.title}」已废弃`,
    predecessor.abandonReason ? `，原因是：${predecessor.abandonReason}` : '',
    '。',
    branches.length ? `它的改动在分支 ${branches.join('、')} 上，可以用 git 查看作参考，但不要直接沿用。` : ''
  ].join('')
}

function planExcerpt(dependency: Dependency): string {
  const plan = dependency.details.trim()
  if (plan === '') {
    return '（还没有详情）'
  }
  if (plan.length <= PLAN_EXCERPT_LIMIT) {
    return plan
  }
  const rest = plan.length - PLAN_EXCERPT_LIMIT
  return `${plan.slice(0, PLAN_EXCERPT_LIMIT)}\n……（还有 ${rest} 字，用 ${READ_TASK_TOOL} 读取完整内容）`
}

// Tags keep an unfinished dependency's own headings from reading as part of this task.
function dependencyDetailsSection(workspace: RefineWorkspace, dependencies: readonly Dependency[]): string | null {
  if (dependencies.length === 0) {
    return null
  }
  const plans = dependencies
    .filter((dependency) => dependency.status !== 'done')
    .map((dependency) => {
      const attributes = `id="${shortTaskId(dependency.id)}" title="${dependency.title.replaceAll('"', "'")}" status="${STATUS_TEXT[dependency.status]}"`
      return `<dependency ${attributes}>\n${planExcerpt(dependency)}\n</dependency>`
    })
  return [
    [
      '本任务依赖下面这些任务，它们完成后本任务才能执行。细化时要衔接好它们：不重复它们的工作，用好它们留下的接口。',
      ...dependencies.map((dependency) => dependencyLine(workspace.landed, dependency))
    ].join('\n'),
    ...plans,
    `需要某个依赖任务（包括依赖的依赖）的完整详情时，调用 kando 的 ${READ_TASK_TOOL} 工具，传入任务 id。`
  ].join('\n\n')
}

// The user's title and details, plus what the agent cannot see for itself:
// which folder is which repo, and where the work it builds on lives.
export function agentPrompt(
  task: Pick<Task, 'title' | 'details' | 'source' | 'sourceSnapshot'>,
  workspace: Workspace,
  dependencies: readonly Pick<Task, 'id' | 'title' | 'repos'>[],
  predecessor: Predecessor | null = null,
  images: PromptImages = NO_IMAGES
): string {
  const sections = [
    taskPrompt(task),
    imageSection(images.attached),
    sourceSection(task, images),
    workspaceSection(workspace),
    dependencySection(workspace, dependencies),
    predecessorSection(predecessor)
  ]
  return sections.filter((section) => section !== null).join('\n\n')
}

// Continuing is a new session on the old worktree: the agent only knows what the code
// and its history tell it, so it catches up first and then waits for the new ask.
export function continuePrompt(
  task: Pick<Task, 'title' | 'details' | 'repos' | 'source' | 'sourceSnapshot'>,
  workspace: Workspace,
  dependencies: readonly Pick<Task, 'id' | 'title' | 'repos'>[],
  images: PromptImages = NO_IMAGES
): string {
  const branches = task.repos.flatMap((repo) => (repo.branch ? [repo.branch] : []))
  const sections = [
    [
      '这个任务之前已经执行过一次，现在继续做。',
      branches.length
        ? `上次的改动就在当前目录的分支 ${branches.join('、')} 上，可以用 git log / git diff 查看。`
        : '上次的改动就在当前目录里。'
    ].join(''),
    taskPrompt(task),
    imageSection(images.attached),
    sourceSection(task, images),
    workspaceSection(workspace),
    dependencySection(workspace, dependencies),
    '请先用几句话总结上次已经完成了什么、还有什么没做完，然后等我告诉你接下来要改什么，不要自己开始改。'
  ]
  return sections.filter((section) => section !== null).join('\n\n')
}

// Refining is a conversation, so the prompt sets the rules and asks for the plan back
// through the tool; the agent should not start implementing.
export function refinePrompt(
  task: Pick<Task, 'title' | 'details' | 'source' | 'sourceSnapshot'>,
  agent: AgentKind,
  workspace: RefineWorkspace,
  dependencies: readonly Dependency[],
  predecessor: Predecessor | null = null,
  images: PromptImages = NO_IMAGES
): string {
  const steps = [
    '1. 先阅读相关代码，了解现状。',
    '2. 有不清楚的地方先问我，每次问几个最关键的问题。',
    `3. 我们达成一致后，调用 kando 的 ${PROPOSE_DETAILS_TOOL} 工具，提交一份完整的任务详情（Markdown），包含：目标、背景、实现方案、涉及的文件、验收标准。它会替换现在的详情，所以要写完整，不要只写改动的部分。`,
    '4. 之后我可能还会请你修改，改完重新提交即可，新的一版会替换上一版。'
  ]
  if (agent === 'claude') {
    // ExitPlanMode would hand the session over to implementing once the user says yes.
    steps.push('5. 不要调用 ExitPlanMode，方案只通过上面的工具提交。')
  }
  const sections = [
    '我们先一起把这个开发任务细化清楚。这次只讨论和规划，不要修改任何文件，也不要开始实现。',
    `任务：${task.title}`,
    `现在的详情：\n${task.details.trim() || '（还没有详情）'}`,
    imageSection(images.attached),
    sourceSection(task, images),
    codeSection(workspace),
    dependencyDetailsSection(workspace, dependencies),
    predecessorSection(predecessor),
    ['请这样进行：', ...steps].join('\n')
  ]
  return sections.filter((section) => section !== null).join('\n\n')
}
