import type { AgentKind, SourceFailure, SourceProblem, TaskStatus } from '@kando/protocol'

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '未执行',
  running: '执行中',
  review: '待验收',
  done: '已完成',
  abandoned: '已废弃'
}

export const STATUS_HINT: Record<TaskStatus, string> = {
  pending: '还没交给 agent',
  running: 'agent 正在执行',
  review: 'agent 已结束，等你看过结果后接受、继续修改或重做',
  done: '结果已接受，依赖它的任务可以执行了',
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
  'not-pending': '只有未执行的任务可以执行；执行过的任务可以继续或重做',
  'not-done': '只有待验收或已完成的任务可以继续或重做',
  'missing-repo': '请先添加项目',
  'missing-agent': '请先选择执行的 agent',
  'repo-not-found': '项目路径不存在',
  'repo-path-not-absolute': '项目路径需要是绝对路径（可以用 ~/ 开头）',
  'repo-not-git': '涉及多个项目时，每个目录都必须是 Git 仓库',
  'repo-duplicate': '有两个项目路径指向同一个 Git 仓库',
  'task-running': '执行中不能修改项目',
  'task-abandoned': '已废弃的任务不能修改项目',
  'primary-fixed': '任务的对话开始后不能更换主项目，附加项目仍可增删',
  'branch-exists': '任务分支已经建好，起点不能再改',
  'task-active': '任务还没完成或废弃',
  'worktree-locked': '已用 git worktree lock 锁定',
  'worktree-unreadable': '读不了它的 git 状态',
  'worktree-dirty': '有没提交的改动',
  'worktree-alone': '有只在它里面的提交',
  'worktree-not-found': '找不到这个 worktree，可能已经删了',
  'worktree-in-use': 'agent 正在里面工作',
  'uncommitted-changes': '有未提交的改动，先提交或暂存再切换',
  'branch-elsewhere': '这个分支已在另一个 worktree 里检出',
  'branch-not-found': '找不到这个分支',
  'branch-switch-failed': '切换分支失败',
  'invalid-branch-name': '分支名不合法',
  'branch-name-taken': '已经有同名的分支',
  'git-no-changes': '没有可以提交的改动',
  'git-no-branch': '当前处于分离 HEAD，不能推送分支',
  'git-no-remote': '当前分支没有 upstream，项目也没有 origin',
  'invalid-start': '起点必须是一个分支',
  'start-not-found': '找不到选的起点分支，请在任务详情里重新选择',
  blocked: '依赖的任务还没完成（执行完并验收通过）',
  'dependency-cycle': '不能形成循环依赖',
  refining: '细化会话还在进行，先在终端里退出 agent 结束它',
  'refine-in-progress': '细化会话已经在进行',
  'no-proposal': '没有待确认的方案',
  'nothing-to-restore': '没有可以撤销的替换',
  'worktree-failed': '创建 git worktree 失败',
  'daemon-unavailable': '终端守护进程没有运行（pnpm dev:daemon）',
  'command-not-found': '找不到 agent 命令（claude 或 codex），请先安装并确认它在 PATH 里',
  'run-in-progress': '任务正在启动，请稍候',
  'task-not-found': '任务不存在',
  'session-not-found': '会话已不存在',
  'conversation-not-found': '会话不存在',
  'conversation-running': '这条会话正在运行或启动，请先停止',
  'conversation-same-agent': '请选择另一个 agent 进行移交',
  'conversation-event-invalid': '会话事件与当前阶段不匹配',
  'invalid-workspace': '项目必须是已存在的绝对目录',
  'too-many-projects': '一条会话最多选择 10 个项目',
  'duplicate-project': '不能重复选择同一个项目目录',
  'chat-starting': 'agent 还在启动，稍等再发',
  'chat-busy': 'agent 还在处理上一条消息',
  'chat-image-too-large': 'Claude Code 只接受 5MB 以内的图片',
  'chat-idle': '现在没有进行中的回合',
  'chat-request-gone': '这个请求已经不再等待回答',
  'browser-unavailable': '浏览器没有运行',
  'browser-not-installed': '浏览器还没安装，在设置里下载 Chromium',
  'browser-installing': '浏览器正在下载，稍后再试',
  'browser-start-failed': '浏览器宿主没有启动',
  'browser-tab-not-found': '标签页已经关闭',
  'browser-not-watching': '先打开这个会话的浏览器面板',
  'browser-user-driving': '你正在操作这个标签页',
  'browser-navigation-failed': '页面打不开',
  'browser-ref-not-found': '页面上找不到这个元素了',
  'chat-not-running': '这条会话的 agent 没有以聊天界面运行',
  'chat-session': '这条会话运行在聊天界面，没有终端可以连接',
  'chat-start-timeout': 'agent 太久没有完成启动',
  'daemon-outdated': '正在运行的终端守护进程版本太旧，不支持聊天界面，请重启它（pnpm dev:daemon）',
  'stage-not-found': '找不到更早的聊天记录',
  'chat-option-invalid': '这里用不了这个选项',
  'chat-nothing-queued': '没有排队的消息',
  'chat-no-steer': '这个 agent 不接受回合中的追加指令，先排队吧',
  'chat-task': '这个任务在聊天界面里进行，直接在聊天里发消息',
  planning: '依赖的任务还没完成，现在只能规划；在聊天里继续，或保存计划等它们完成',
  'plan-only': '依赖的任务还没完成，现在只能规划，不能动手改',
  'not-planning': '只有只读规划时的计划需要保存，执行中的计划确认后就会开始做',
  'not-running': '只有执行中的任务可以提交验收',
  'not-chat': '在终端里执行的任务，agent 退出后自动进入待验收',
  'agent-working': 'agent 还在处理，等这一轮结束再提交',
  'no-chat': '这个任务还没有开始聊天',
  abandoned: '已废弃的任务不能继续',
  'task-conversation': '这条会话属于一个任务，请从任务那里继续',
  'managed-workspace': '没选项目的会话在 Kando 的临时目录里运行，不能再添加项目',
  'chat-unavailable': '这个 core 不支持聊天界面'
}

// Reasons whose message says what went wrong in the agent's own words, kept after the summary.
const REASON_WITH_DETAIL: Record<string, string> = {
  'chat-start-failed': 'agent 没能以聊天界面启动',
  'git-commit-failed': '提交失败',
  'git-push-failed': '提交已经保留在本地，但推送失败'
}

export function reasonText(reason: string, fallback: string): string {
  const summary = REASON_WITH_DETAIL[reason]
  if (summary) return fallback && fallback !== reason ? `${summary}：${fallback}` : summary
  return REASON_TEXT[reason] ?? fallback
}

// "9月25日 09:28": this app's timestamps are recent enough that the year is noise.
export function dayAndTime(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
