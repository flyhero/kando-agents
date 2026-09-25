import { describe, expect, it } from 'vitest'
import { conversationCommand, handoffPrompt, handoffPromptPath } from './conversation-command'

describe('conversationCommand', () => {
  const callback = ['/path with spaces/node', 'callback.js', 'fixed-id']

  it('uses exec-form Claude hooks and native resume without shell interpolation', () => {
    const first = conversationCommand('claude', 'provider-id', false, callback, null)
    expect(first.args).toEqual(expect.arrayContaining(['--session-id', 'provider-id']))
    const settings = JSON.parse(first.args[first.args.indexOf('--settings') + 1]!)
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ command: callback[0], args: callback.slice(1) })
    expect(settings.hooks.StopFailure).toHaveLength(1)
    const resumed = conversationCommand('claude', 'provider-id', true, callback, '/kando/handoff.md')
    expect(resumed.args).toEqual(expect.arrayContaining(['--resume', 'provider-id', '--allowedTools', 'Read(//kando/handoff.md)']))
  })

  it('starts Codex interactively and resumes only a known thread', () => {
    expect(conversationCommand('codex', null, false, callback, null).args).not.toContain('resume')
    const resumed = conversationCommand('codex', 'thread-id', true, callback, '/kando/handoff.md')
    expect(resumed.args).toEqual(expect.arrayContaining(['resume', 'thread-id']))
    expect(resumed.args.at(-1)).toContain('/kando/handoff.md')
  })

  it('reads the handoff path back out of the prompt it sent, and only from that prompt', () => {
    expect(handoffPromptPath(`  ${handoffPrompt('/kando/sessions/c/handoffs/h.md')}\n`)).toBe('/kando/sessions/c/handoffs/h.md')
    expect(handoffPromptPath('请先阅读 Kando 移交文件，然后告诉我里面写了什么')).toBeNull()
  })
})
