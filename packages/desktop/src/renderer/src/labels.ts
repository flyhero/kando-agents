import type { AgentKind, SourceFailure, SourceProblem, TaskStatus } from '@kando/protocol'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '未执行',
  running: '执行中',
  done: '已执行',
  abandoned: '已废弃'
}

export const STATUS_HINT: Record<TaskStatus, string> = {
  pending: '还没交给 agent',
  running: 'agent 正在执行',
  done: 'agent 已结束，等待验收',
  abandoned: '已废弃，由继承它的新任务接着做'
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

const SOURCE_FAILURE_TEXT: Record<SourceFailure, string> = {
  'not-configured': '还没有设置好或没有登录',
  'invalid-settings': '设置不对',
  'auth-failed': '认证失败：账号或 token 不对，或者已经过期',
  forbidden: '没有权限访问这些 issue',
  'bad-query': '筛选条件写得不对',
  'not-found': '找不到这个 issue，可能已被删除，或者你没有权限查看',
  'request-failed': '连不上',
  'response-too-large': '返回的内容太大，已拒绝接收',
  'login-cancelled': '登录已取消',
  'login-timeout': '太久没有回应，登录已结束'
}

// The tracker's own words say which part is wrong, or what the network did.
export function sourceProblemText(problem: SourceProblem): string {
  const text = SOURCE_FAILURE_TEXT[problem.code]
  const specific = ['invalid-settings', 'bad-query', 'request-failed'].includes(problem.code)
  return specific ? `${text}（${problem.message}）` : text
}

const REASON_TEXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SOURCE_FAILURE_TEXT).map(([code, text]) => [`source-${code}`, text])),
  'source-already-imported': '这个 issue 已经导入成任务了',
  'attachment-not-image': '只支持 PNG、JPEG、GIF 和 WebP 图片',
  'attachment-too-many-pixels': '图片尺寸太大（超过 4000 万像素或单边超过 16384）',
  'attachment-too-large': '图片超过 10MB',
  'attachment-not-found': '图片文件已经不存在了',
  'attachment-busy': '同时上传的图片太多，请稍后再试',
  'too-many-images': '一个任务最多 20 张图片',
  'source-invalid-key': '这不是一个有效的 issue key',
  'source-unknown': '没有这个任务来源',
  'source-none': '这个任务不是从任务来源导入的',
  'source-login-in-progress': '这个来源已经有一个登录在进行',
  'source-login-not-found': '登录已经结束',
  'source-login-stale': '这个问题已经过期，请重新登录',
  'invalid-transition': '当前状态不能这样移动',
  'not-pending': '只有未执行的任务可以执行；已执行的任务可以继续或重做',
  'not-done': '只有已执行的任务可以继续或重做',
  'missing-repo': '请先添加项目',
  'missing-agent': '请先选择执行的 agent',
  'repo-not-found': '项目路径不存在',
  'repo-path-not-absolute': '项目路径需要是绝对路径（可以用 ~/ 开头）',
  'repo-not-git': '涉及多个项目时，每个目录都必须是 Git 仓库',
  'repo-duplicate': '有两个项目路径指向同一个 Git 仓库',
  'task-running': '执行中不能修改项目',
  blocked: '依赖的任务还没执行完',
  'dependency-cycle': '不能形成循环依赖',
  refining: '细化会话还在进行，先在终端里退出 agent 结束它',
  'refine-in-progress': '细化会话已经在进行',
  'no-proposal': '没有待确认的方案',
  'nothing-to-restore': '没有可以撤销的替换',
  'worktree-failed': '创建 git worktree 失败',
  'daemon-unavailable': '终端守护进程没有运行（pnpm dev:daemon）',
  'run-in-progress': '任务正在启动，请稍候',
  'task-not-found': '任务不存在',
  'session-not-found': '会话已不存在',
  'conversation-not-found': '自由会话不存在',
  'conversation-running': '这条会话正在运行或启动，请先停止',
  'conversation-same-agent': '请选择另一个 agent 进行移交',
  'conversation-event-invalid': '会话事件与当前阶段不匹配',
  'invalid-workspace': '项目必须是已存在的绝对目录',
  'too-many-projects': '一条会话最多选择 10 个项目',
  'duplicate-project': '不能重复选择同一个项目目录'
}

export function reasonText(reason: string, fallback: string): string {
  return REASON_TEXT[reason] ?? fallback
}

// "9月25日 09:28": this app's timestamps are recent enough that the year is noise.
export function dayAndTime(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
