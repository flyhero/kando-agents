import { useMemo } from 'react'
import { AGENT_KINDS, type AgentKind, type Environment } from '@kando/protocol'
import { useCore } from './core-store'

// The agents Kando can start here: those core found on its path, in Kando's own order. Before
// core says, or on a core that does not look, every agent Kando knows, as before. None found
// also offers every one: the user then sees what there is to install, not an empty list, and the
// environment notice says what is wrong.
export function installedAgents(environment: Environment | null): readonly AgentKind[] {
  if (!environment) return AGENT_KINDS
  const found = AGENT_KINDS.filter((kind) => environment.checks.some((check) => check.tool === kind && check.status !== 'missing'))
  return found.length > 0 ? found : AGENT_KINDS
}

// The agent a conversation could hand off to, or be told has room: another one that is here.
export function otherInstalledAgent(agent: AgentKind, installed: readonly AgentKind[]): AgentKind | null {
  return installed.find((kind) => kind !== agent) ?? null
}

export function useInstalledAgents(): readonly AgentKind[] {
  const environment = useCore((s) => s.environment)
  return useMemo(() => installedAgents(environment), [environment])
}
