import { useMemo } from 'react'
import { AGENT_KINDS, type AgentKind, type Environment } from '@kando/protocol'
import { useCore } from './core-store'
import { usePreferences } from './preferences'

// The agents core found on its path, in Kando's own order. Before core says, or on a core that
// does not look, every agent Kando knows, as before. None found also offers every one: the user
// then sees what there is to install, not an empty list, and the environment notice says what is
// wrong.
export function detectedAgents(environment: Environment | null): readonly AgentKind[] {
  if (!environment) return AGENT_KINDS
  const found = AGENT_KINDS.filter((kind) => environment.checks.some((check) => check.tool === kind && check.status !== 'missing'))
  return found.length > 0 ? found : AGENT_KINDS
}

// The agents Kando offers here: those found, less the ones the user turned off. Turning off every
// one is not allowed, but should it happen the found ones stand, so there is always a choice.
export function installedAgents(environment: Environment | null, disabled: readonly AgentKind[] = []): readonly AgentKind[] {
  const detected = detectedAgents(environment)
  const enabled = detected.filter((kind) => !disabled.includes(kind))
  return enabled.length > 0 ? enabled : detected
}

// The same, read outside a component.
export function currentInstalledAgents(): readonly AgentKind[] {
  return installedAgents(useCore.getState().environment, usePreferences.getState().disabledAgents)
}

// The agent a conversation could hand off to, or be told has room: another one that is here.
export function otherInstalledAgent(agent: AgentKind, installed: readonly AgentKind[]): AgentKind | null {
  return installed.find((kind) => kind !== agent) ?? null
}

export function useInstalledAgents(): readonly AgentKind[] {
  const environment = useCore((s) => s.environment)
  const disabled = usePreferences((s) => s.disabledAgents)
  return useMemo(() => installedAgents(environment, disabled), [environment, disabled])
}
