import type { AgentCliInstallation, AgentKind, Environment, Terminal } from '@kando/protocol'
import type { EnvironmentService } from './environment-check'
import type { TerminalService } from './terminal-service'
import { Rejection } from './rejection'

// Commands published by Cursor, selected for the core host rather than the client OS.
export function cursorInstallation(platform: NodeJS.Platform): AgentCliInstallation | null {
  if (platform === 'win32') return { agent: 'cursor', shell: 'powershell', command: "irm 'https://cursor.com/install?win32=true' | iex" }
  if (platform === 'darwin' || platform === 'linux') return { agent: 'cursor', shell: 'bash', command: 'curl https://cursor.com/install -fsS | bash' }
  return null
}

export function agentCliInstallations(environment: Pick<Environment, 'checks' | 'detectedAgents'>, platform: NodeJS.Platform): AgentCliInstallation[] {
  const installation = cursorInstallation(platform)
  if (!installation) return []
  const check = environment.checks.find((each) => each.tool === installation.agent)
  const locations = environment.detectedAgents?.find((each) => each.id === installation.agent)?.locations ?? []
  return check?.status === 'missing' && check.path === null &&
    locations.some((each) => each.source === 'application') && !locations.some((each) => each.source === 'cli')
    ? [installation] : []
}

export class AgentCliInstaller {
  private readonly pending = new Map<AgentKind, Promise<Terminal>>()

  constructor(private readonly environment: Pick<EnvironmentService, 'check'>, private readonly terminals: Pick<TerminalService, 'list' | 'installCli'>) {}

  install(agent: AgentKind): Promise<Terminal> {
    const pending = this.pending.get(agent)
    if (pending) return pending
    const installing = this.start(agent).finally(() => this.pending.delete(agent))
    this.pending.set(agent, installing)
    return installing
  }

  private async start(agent: AgentKind): Promise<Terminal> {
    const environment = await this.environment.check(true)
    const installation = environment.cliInstallations?.find((each) => each.agent === agent)
    if (!installation) throw new Rejection('agent-cli-install-unavailable', '仅在检测到 App 且未找到 CLI 时可以安装，请重新检测')
    // The row survives core restarts, so another window or a reconnect uses the running tab.
    const running = this.terminals.list().find((each) => !each.conversationId && each.command === installation.command && !each.exited)
    if (running) return running
    const terminal = await this.terminals.installCli(installation)
    if (terminal.exited) await this.environment.check(true)
    return terminal
  }
}
