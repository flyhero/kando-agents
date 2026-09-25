import type { AgentKind } from '@kando/protocol'
import { claudeHookArgs, codexNotifyArgs, type AgentCommand } from './agent-command'

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
