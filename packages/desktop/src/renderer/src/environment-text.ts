import type { EnvironmentCheck, EnvironmentProblem, EnvironmentTool } from '@kando/protocol'
import { AGENT_LABEL } from './labels'

export const TOOL_LABEL: Record<EnvironmentTool, string> = { git: 'Git', claude: AGENT_LABEL.claude, codex: AGENT_LABEL.codex, cursor: AGENT_LABEL.cursor }

export const TOOL_ROLE: Record<EnvironmentTool, string> = {
  git: '每个任务在自己的 worktree 里执行，没有 Git 就建不了。',
  claude: '聊天界面以 `claude -p` 运行它；没装也可以只用 Codex。',
  codex: '聊天界面以 `codex app-server` 运行它；没装也可以使用其他 Agent。',
  cursor: '聊天界面以 Cursor CLI 的 ACP 模式运行它；仅安装 Cursor 编辑器还不能执行任务。'
}

const darwin = window.kando?.platform === 'darwin'

// How to put the tool there, as the user would type it; the platform picks the package manager.
export const INSTALL_HINT: Record<EnvironmentTool, string> = {
  git: darwin ? 'xcode-select --install' : '用系统的包管理器安装 git',
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: '按照 cursor.com/docs/cli/installation 安装最新 Cursor CLI'
}

export const SIGN_IN_HINT: Record<EnvironmentTool, string> = {
  git: '',
  claude: '在终端里运行 claude，按提示登录',
  codex: '在终端里运行 codex login',
  cursor: '在终端里运行 agent login'
}

export function checkStatusText(check: EnvironmentCheck): string {
  if (check.status === 'missing') return '未安装'
  if (check.status === 'unknown') return check.tool === 'cursor' && check.version ? `需要升级以支持 ACP（${check.version}）` : '已找到，版本未知'
  return check.version ? `已安装 ${check.version}` : '已安装'
}

export function signedInText(check: EnvironmentCheck): string | null {
  if (check.signedIn === null) return null
  return check.signedIn ? '已登录' : '未登录'
}

// One line for the sidebar: the first thing to fix.
export function problemText(problem: EnvironmentProblem): string {
  switch (problem.code) {
    case 'git-missing':
      return '没有找到 Git，任务建不了 worktree'
    case 'no-agent':
      return '没有找到 Claude Code、Codex 或 Cursor CLI'
    case 'no-signed-in-agent':
      return '装了 Agent，但都还没登录'
    case 'signed-out':
      return `${TOOL_LABEL[problem.tool]} 还没登录`
  }
}
