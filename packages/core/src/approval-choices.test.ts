import { describe, expect, it } from 'vitest'
import { choiceDecisions, claudeChoices, claudeGrants, codexChoiceOf, codexChoices } from './approval-choices'

const MODES = { acceptEdits: 'acceptEdits', default: 'ask' }

describe('approval choices', () => {
  it('reads what Claude suggests remembering, and where it would keep it', () => {
    expect(claudeGrants([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git fetch *' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }, { toolName: 'WebSearch' }], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm *' }], behavior: 'deny', destination: 'userSettings' },
      { type: 'removeRules', rules: [], destination: 'projectSettings' },
      'nonsense'
    ], MODES)).toEqual([
      { kind: 'rules', values: ['Bash(git fetch *)'], scope: 'local', behavior: 'allow' },
      { kind: 'rules', values: ['Read(//tmp/**)', 'WebSearch'], scope: 'run', behavior: 'allow' },
      { kind: 'mode', values: ['acceptEdits'], scope: 'run', behavior: 'allow' },
      { kind: 'directories', values: ['/tmp'], scope: 'run', behavior: 'allow' },
      { kind: 'rules', values: ['Bash(rm *)'], scope: 'user', behavior: 'deny' },
      { kind: 'other', values: [], scope: 'project', behavior: 'allow' },
      { kind: 'other', values: [], scope: 'run', behavior: 'allow' }
    ])
  })

  it('offers remembering only when Claude suggests something to remember', () => {
    expect(claudeChoices([]).map((choice) => choice.id)).toEqual(['allow', 'deny'])
    const grant = { kind: 'rules' as const, values: ['Bash(ls *)'], scope: 'local' as const, behavior: 'allow' as const }
    expect(claudeChoices([grant])).toEqual([
      { id: 'allow', decision: 'allow', grants: [] },
      { id: 'allowForSession', decision: 'allowForSession', grants: [grant] },
      { id: 'deny', decision: 'deny', grants: [] }
    ])
  })

  it('keeps every answer Codex lists, objects as they are, and one way to say no', () => {
    const execpolicy = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat', 'plan.md'] } }
    const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } }
    const choices = codexChoices(['accept', execpolicy, network, 'decline', 'cancel', 'somethingNew'], { kind: 'command', values: ['cat plan.md'] }, 'decline')
    // Codex proposes the command word for word; Kando sends its own short prefix instead.
    const ours = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat'] } }
    expect(choices).toEqual([
      { id: 'accept', decision: 'allow', grants: [], raw: 'accept' },
      { id: 'execpolicy', decision: 'allowForSession', grants: [{ kind: 'prefix', values: ['cat'], scope: 'agent', behavior: 'allow' }], raw: ours },
      { id: 'network:deny:example.com', decision: 'deny', grants: [{ kind: 'host', values: ['example.com'], scope: 'agent', behavior: 'deny' }], raw: network },
      { id: 'decline', decision: 'deny', grants: [], raw: 'decline' }
    ])
    expect(choiceDecisions(choices)).toEqual(['allow', 'allowForSession', 'deny'])
    expect(codexChoiceOf(choices, ours)?.id).toBe('execpolicy')
    // An answer sent with Codex's own prefix, before Kando chose one, reads back as the same choice.
    expect(codexChoiceOf(choices, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat', 'plan.md'] } })?.id).toBe('execpolicy')
    // Nothing to remember for a command that may do anything, nor for one of several different prefixes.
    expect(codexChoices(['accept', execpolicy, 'decline'], { kind: 'command', values: ['rm -rf build'] }, 'decline').map((choice) => choice.id)).toEqual(['accept', 'decline'])
    expect(codexChoices(['accept', execpolicy, 'decline'], { kind: 'command', values: ['git status && pnpm test'] }, 'decline').map((choice) => choice.id)).toEqual(['accept', 'decline'])
    expect(codexChoiceOf(choices, 'acceptForSession')).toBeUndefined()
  })

  it('falls back to once, this run and no for a server that lists nothing', () => {
    expect(codexChoices(null, { kind: 'files', values: ['a.ts'] }, 'decline')).toEqual([
      { id: 'accept', decision: 'allow', grants: [], raw: 'accept' },
      { id: 'acceptForSession', decision: 'allowForSession', grants: [{ kind: 'files', values: ['a.ts'], scope: 'run', behavior: 'allow' }], raw: 'acceptForSession' },
      { id: 'decline', decision: 'deny', grants: [], raw: 'decline' }
    ])
    expect(codexChoices(['accept'], { kind: 'command', values: ['ls'] }, 'cancel').map((choice) => choice.id)).toEqual(['accept', 'cancel'])
  })
})
