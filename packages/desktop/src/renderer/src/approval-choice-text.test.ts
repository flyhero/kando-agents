import { describe, expect, it } from 'vitest'
import type { ApprovalChoice, ApprovalGrant, ChatItem } from '@kando/protocol'
import { choiceAction, choiceText, chosenText, isPlainDeny } from './approval-choice-text'

const grant = (overrides: Partial<ApprovalGrant>): ApprovalGrant => ({ kind: 'rules', values: [], scope: 'run', behavior: 'allow', ...overrides })
const choice = (grants: ApprovalGrant[], decision: ApprovalChoice['decision'] = 'allowForSession'): ApprovalChoice => ({ id: 'c', decision, grants })

describe('approval choice text', () => {
  it('says what a choice remembers, for how long and where it is kept', () => {
    expect(choiceText(choice([grant({ values: ['Bash(git fetch *)'], scope: 'local' })]))).toEqual({
      label: '允许，本项目以后 Bash(git fetch *) 不再问',
      note: '写进本项目的 .claude/settings.local.json（Git 忽略），之后的会话也生效'
    })
    expect(choiceText(choice([grant({ kind: 'prefix', values: ['cat', 'plan.md'], scope: 'agent' })])).label).toBe('允许，以后以 cat plan.md 开头的命令不再问')
    expect(choiceText(choice([grant({ kind: 'command', values: ['ls'] })]))).toEqual({ label: '允许，这次运行内这条命令不再问', note: 'Agent 停下或重启后就失效' })
    expect(choiceText(choice([grant({ kind: 'mode', values: ['acceptEdits'] })])).label).toBe('允许，这次运行内改用「自动接受编辑」模式')
    expect(choiceText(choice([grant({ kind: 'host', values: ['example.com'], scope: 'agent', behavior: 'deny' })], 'deny')).label).toBe('拒绝，以后都不许访问 example.com')
  })

  it('groups what it remembers by scope and shortens long lists', () => {
    const text = choiceText(choice([
      grant({ values: ['Read(//tmp/**)', 'Read(//private/tmp/**)'] }),
      grant({ kind: 'directories', values: ['/tmp'] }),
      grant({ values: ['Bash(a *)', 'Bash(b *)', 'Bash(c *)', 'Bash(d *)'], scope: 'local' })
    ]))
    expect(text.label).toBe('允许，这次运行内 Read(//tmp/**)、Read(//private/tmp/**) 不再问，访问 /tmp 不再问；本项目以后 Bash(a *)、Bash(b *)、Bash(c *) 等 4 项 不再问')
    expect(text.note).toBe('Agent 停下或重启后就失效；写进本项目的 .claude/settings.local.json（Git 忽略），之后的会话也生效')
  })

  it('keeps plain answers plain', () => {
    expect(choiceText(choice([], 'allow'))).toEqual({ label: '允许这一次', note: null })
    expect(isPlainDeny(choice([], 'deny'))).toBe(true)
    expect(isPlainDeny(choice([grant({ kind: 'host', behavior: 'deny' })], 'deny'))).toBe(false)
    expect([choice([], 'allow'), choice([grant({})]), choice([grant({ kind: 'host', behavior: 'deny' })], 'deny')].map(choiceAction)).toEqual(['允许', '允许并记住', '拒绝并记住'])
  })

  it('says what an answer remembered, once answered with such a choice', () => {
    const item = (chosen: string | null): Extract<ChatItem, { kind: 'approval' }> => ({
      id: 'a:1', stageId: 's', revision: 1, kind: 'approval', at: 0, requestId: '1', tool: 'Bash', title: 'git fetch', detail: null, toolItemId: null,
      decisions: ['allow', 'allowForSession', 'deny'], resolution: 'allowedForSession', chosen,
      choices: [{ id: 'allow', decision: 'allow', grants: [] }, { id: 'always', decision: 'allowForSession', grants: [grant({ values: ['Bash(git fetch *)'], scope: 'local' })] }]
    })
    expect(chosenText(item('always'))).toBe('已允许，本项目以后 Bash(git fetch *) 不再问')
    expect(chosenText(item('allow'))).toBeNull()
    expect(chosenText(item(null))).toBeNull()
  })
})
