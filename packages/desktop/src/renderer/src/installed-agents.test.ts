import { describe, expect, it } from 'vitest'
import type { Environment, EnvironmentCheck } from '@kando/protocol'
import { installedAgents, otherInstalledAgent } from './installed-agents'

const check = (tool: EnvironmentCheck['tool'], status: EnvironmentCheck['status']): EnvironmentCheck => ({ tool, status, version: null, path: null, signedIn: null })
const environment = (...checks: EnvironmentCheck[]): Environment => ({ checks, searchPath: [], checkedAt: 0 })

describe('installedAgents', () => {
  it('offers every agent until core has looked', () => {
    expect(installedAgents(null)).toEqual(['claude', 'codex'])
  })

  it('offers what core found, a shim it could not ask included', () => {
    expect(installedAgents(environment(check('git', 'ok'), check('claude', 'ok'), check('codex', 'missing')))).toEqual(['claude'])
    expect(installedAgents(environment(check('claude', 'missing'), check('codex', 'unknown')))).toEqual(['codex'])
  })

  it('offers every agent when none is found, so there is something to install', () => {
    expect(installedAgents(environment(check('git', 'ok'), check('claude', 'missing'), check('codex', 'missing')))).toEqual(['claude', 'codex'])
  })
})

describe('otherInstalledAgent', () => {
  it('names another agent that is here, or none', () => {
    expect(otherInstalledAgent('claude', ['claude', 'codex'])).toBe('codex')
    expect(otherInstalledAgent('claude', ['claude'])).toBeNull()
    expect(otherInstalledAgent('codex', ['claude'])).toBe('claude')
  })
})
