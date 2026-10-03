import { describe, expect, it } from 'vitest'
import { chatCommand, handoffPrompt, handoffPromptPath } from './conversation-command'

describe('handoffPromptPath', () => {
  it('reads the handoff path back out of the prompt it sent, and only from that prompt', () => {
    expect(handoffPromptPath(`  ${handoffPrompt('/kando/sessions/c/handoffs/h.md')}\n`)).toBe('/kando/sessions/c/handoffs/h.md')
    expect(handoffPromptPath('请先阅读 Kando 移交文件，然后告诉我里面写了什么')).toBeNull()
  })
})

describe('chatCommand', () => {
  it('gives Codex Kando\'s tools and hides the ChatGPT app\'s browser beside them', () => {
    const mcp = { command: 'node', args: ['mcp.mjs', '--home', '/k'] }
    const args = chatCommand('codex', null, false, null, [], { mcp }).args
    expect(args.slice(0, 5)).toEqual(['app-server', '-c', 'mcp_servers.kando.command="node"', '-c', 'mcp_servers.kando.args=["mcp.mjs","--home","/k"]'])
    expect(args).toEqual(expect.arrayContaining(['-c', 'mcp_servers.cua_repl={command="/usr/bin/true",enabled=false}']))
    // Without Kando's tools there is nothing to choose between, and nothing is hidden.
    expect(chatCommand('codex', null, false, null, []).args).toEqual(['app-server'])
  })

  it('starts Claude with what the conversation chose, and bypass only when allowed now', () => {
    const args = chatCommand('claude', 'session-1', true, null, [], { preferred: { permissionMode: 'plan', model: 'sonnet', effort: 'high' } }).args
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'high', '--resume', 'session-1']))
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
    expect(chatCommand('claude', 's', false, null, [], { preferred: { permissionMode: 'bypass' } }).args).not.toContain('--permission-mode')
    const allowed = chatCommand('claude', 's', false, null, [], { preferred: { permissionMode: 'bypass' }, allowBypass: true }).args
    expect(allowed).toEqual(expect.arrayContaining(['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']))
    // Asking is passed as manual, so a default mode in Claude Code's settings cannot override it.
    expect(chatCommand('claude', 's', false, null, [], { preferred: { permissionMode: 'ask' } }).args).toEqual(expect.arrayContaining(['--permission-mode', 'manual']))
    expect(chatCommand('claude', 's', false, null, []).args).not.toContain('--permission-mode')
  })

  it('starts a Claude stage that may only plan in plan mode, its folders not editable and no bypass', () => {
    const args = chatCommand('claude', 's', false, null, ['/code/web'], {
      preferred: { permissionMode: 'acceptEdits' },
      allowBypass: true,
      planOnly: { dirs: ['/code/app', '/code/web'] },
      readable: ['/kando/attachments/a.png']
    }).args
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--disallowedTools', 'Edit(//code/app/**),Edit(//code/web/**)']))
    expect(args).not.toContain('--allow-dangerously-skip-permissions')
    // One list of what it may read: its images and git history.
    expect(args.filter((arg) => arg === '--allowedTools')).toHaveLength(1)
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read(//kando/attachments/a.png),Bash(git log:*),Bash(git diff:*),Bash(git show:*)')
  })
})
