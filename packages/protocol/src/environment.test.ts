import { describe, expect, it } from 'vitest'
import { blocksEverything, environmentProblems, type EnvironmentCheck } from './environment'

const check = (tool: EnvironmentCheck['tool'], status: EnvironmentCheck['status'], signedIn: boolean | null = null): EnvironmentCheck => ({
  tool,
  status,
  version: status === 'ok' ? '1.0.0' : null,
  path: status === 'missing' ? null : `/usr/bin/${tool}`,
  signedIn
})

describe('environmentProblems', () => {
  it('finds nothing wrong with git and a signed-in agent', () => {
    expect(environmentProblems({ checks: [check('git', 'ok'), check('claude', 'ok', true), check('codex', 'missing')] })).toEqual([])
  })

  it('reports git first, then the agents', () => {
    const problems = environmentProblems({ checks: [check('git', 'missing'), check('claude', 'missing'), check('codex', 'missing')] })
    expect(problems).toEqual([{ code: 'git-missing' }, { code: 'no-agent' }])
    expect(problems.every(blocksEverything)).toBe(true)
  })

  it('tells one agent signed out from none signed in', () => {
    expect(environmentProblems({ checks: [check('git', 'ok'), check('claude', 'ok', false), check('codex', 'ok', true)] })).toEqual([
      { code: 'signed-out', tool: 'claude' }
    ])
    expect(environmentProblems({ checks: [check('git', 'ok'), check('claude', 'ok', false), check('codex', 'ok', false)] })).toEqual([
      { code: 'no-signed-in-agent' }
    ])
    expect(blocksEverything({ code: 'signed-out', tool: 'claude' })).toBe(false)
  })

  it('gives a tool it could not ask the benefit of the doubt', () => {
    expect(environmentProblems({ checks: [check('git', 'unknown'), check('claude', 'unknown'), check('codex', 'missing')] })).toEqual([])
    expect(environmentProblems({ checks: [check('git', 'ok'), check('claude', 'unknown'), check('codex', 'ok', false)] })).toEqual([
      { code: 'signed-out', tool: 'codex' }
    ])
  })
})
