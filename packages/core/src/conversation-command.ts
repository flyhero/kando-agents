import type { AgentKind } from '@kando/protocol'
import { claudeHookArgs, codexNotifyArgs, type AgentCommand } from './agent-command'

export function conversationCommand(
  agent: AgentKind,
  providerSessionId: string | null,
  resume: boolean,
  callbackCommand: readonly string[],
  handoffPath: string | null,
  extraProjects: readonly string[] = []
): AgentCommand {
  const prompt = handoffPath ? `请先阅读 Kando 移交文件 ${handoffPath}，结合当前项目目录现状继续协助用户。` : null
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
