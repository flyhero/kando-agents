import type { AgentKind } from '@kando/protocol'
import { claudeEditDenials, claudeHookArgs, claudeReadRules, codexNotifyArgs, GIT_READ_TOOLS, type AgentCommand } from './agent-command'
import type { ChatPreferences } from './chat-driver'
import { CLAUDE_MODE_NAMES } from './claude-stream'

const HANDOFF_PREFIX = '请先阅读 Kando 移交文件 '
const HANDOFF_SUFFIX = '，结合当前项目目录现状继续协助用户。'

export function handoffPrompt(handoffPath: string): string {
  return `${HANDOFF_PREFIX}${handoffPath}${HANDOFF_SUFFIX}`
}

// The agent reports the handoff prompt back as the user's first message; this finds its path.
export function handoffPromptPath(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(HANDOFF_PREFIX) || !trimmed.endsWith(HANDOFF_SUFFIX)) return null
  return trimmed.slice(HANDOFF_PREFIX.length, -HANDOFF_SUFFIX.length)
}

// A chat-mode agent speaks JSON lines over stdio: no hooks (the stream carries every message),
// and no prompt in argv (messages, the handoff prompt included, go to stdin).
export function chatCommand(
  agent: AgentKind,
  providerSessionId: string | null,
  resume: boolean,
  handoffPath: string | null,
  extraProjects: readonly string[] = [],
  launch: {
    preferred?: ChatPreferences
    allowBypass?: boolean
    // Plans only, read-only in these folders: plan mode, their files never editable, no bypass.
    planOnly?: { dirs: readonly string[] }
    // Files the agent may read without asking, such as a task's images.
    readable?: readonly string[]
  } = {}
): AgentCommand {
  if (agent === 'claude') {
    const { preferred = {}, planOnly, readable = [] } = launch
    const allowBypass = (launch.allowBypass ?? false) && !planOnly
    // A remembered bypass needs the user's say-so for this start too. Asking goes by manual on
    // the command line, and is passed too, so Claude Code's own default mode cannot override it.
    const chosen = preferred.permissionMode && (preferred.permissionMode !== 'bypass' || allowBypass) ? preferred.permissionMode : undefined
    const allowed = planOnly ? 'plan' : chosen
    const wanted = allowed === 'ask' ? 'manual' : allowed ? CLAUDE_MODE_NAMES[allowed] : undefined
    const reads = [
      ...(handoffPath ? [`Read(/${handoffPath})`] : []),
      ...claudeReadRules(readable),
      // Planning around what dependencies left on their branches means reading git history.
      ...(planOnly ? GIT_READ_TOOLS : [])
    ]
    const denials = planOnly ? claudeEditDenials(planOnly.dirs) : []
    return { command: 'claude', args: [
      '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      // Makes bypass a mode the user can switch to, without starting in it.
      ...(allowBypass ? ['--allow-dangerously-skip-permissions'] : []),
      ...(wanted ? ['--permission-mode', wanted] : []),
      ...(preferred.model ? ['--model', preferred.model] : []),
      ...(preferred.effort ? ['--effort', preferred.effort] : []),
      ...(resume && providerSessionId ? ['--resume', providerSessionId] : providerSessionId ? ['--session-id', providerSessionId] : []),
      ...extraProjects.flatMap((project) => ['--add-dir', project]),
      ...(denials.length ? ['--disallowedTools', denials.join(',')] : []),
      ...(reads.length ? ['--allowedTools', reads.join(',')] : [])
    ] }
  }
  // app-server takes the thread, sandbox and extra roots over the protocol instead.
  return { command: 'codex', args: ['app-server'] }
}

export function conversationCommand(
  agent: AgentKind,
  providerSessionId: string | null,
  resume: boolean,
  callbackCommand: readonly string[],
  handoffPath: string | null,
  extraProjects: readonly string[] = []
): AgentCommand {
  const prompt = handoffPath ? handoffPrompt(handoffPath) : null
  if (agent === 'claude') {
    return { command: 'claude', args: [
      ...(resume && providerSessionId ? ['--resume', providerSessionId] : providerSessionId ? ['--session-id', providerSessionId] : []),
      ...extraProjects.flatMap((project) => ['--add-dir', project]),
      ...claudeHookArgs(callbackCommand, ['UserPromptSubmit', 'Stop', 'StopFailure']),
      ...(handoffPath ? ['--allowedTools', `Read(/${handoffPath})`] : []),
      ...(prompt ? ['--', prompt] : [])
    ] }
  }
  return { command: 'codex', args: [
    ...codexNotifyArgs(callbackCommand),
    ...extraProjects.flatMap((project) => ['--add-dir', project]),
    ...(resume && providerSessionId ? ['resume', providerSessionId] : []),
    ...(prompt ? ['--', prompt] : [])
  ] }
}
