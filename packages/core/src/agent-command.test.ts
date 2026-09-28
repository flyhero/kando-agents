import { describe, expect, it } from 'vitest'
import { agentCommand, refineCommand } from './agent-command'

const images = {
  attached: ['/home/me/.kando/attachments/a.png', '/home/me/odd,name/b.png'],
  all: ['/home/me/.kando/attachments/a.png', '/home/me/odd,name/b.png', '/home/me/.kando/attachments/c.png']
}
const mcp = { command: 'kando', args: ['mcp'] }

describe('agent commands with images', () => {
  it.each(['claude', 'codex'] as const)('passes additional worktrees as argv to %s before the prompt', (agent) => {
    const dirs = ['/work/web app', '/work/mobile']
    const command = agentCommand(agent, '--prompt stays text', images, ['kando', 'task-event'], dirs)
    expect(command.args.slice(0, 4)).toEqual(['--add-dir', dirs[0], '--add-dir', dirs[1]])
    expect(command.args.slice(-2)).toEqual(['--', '--prompt stays text'])
    expect(command.args).toContain(agent === 'claude' ? '--settings' : 'notify=["kando","task-event"]')
    expect(command.args).toContain(agent === 'claude' ? '--allowedTools' : '--image=/home/me/.kando/attachments/a.png')
  })

  it('keeps additional projects read-only while refining', () => {
    const claude = refineCommand('claude', 'plan', mcp, ['/work/web app'])
    expect(claude.args).toEqual(expect.arrayContaining(['--add-dir', '/work/web app', '--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit']))
    const codex = refineCommand('codex', 'plan', mcp, ['/work/web app'])
    expect(codex.args.slice(0, 2)).toEqual(['--sandbox', 'read-only'])
    expect(codex.args).not.toContain('--add-dir')
  })

  it('lets Claude read exactly those files, and nothing about the folder', () => {
    expect(agentCommand('claude', 'go', images).args).toEqual([
      '--allowedTools',
      'Read(//home/me/.kando/attachments/a.png),Read(//home/me/.kando/attachments/c.png)',
      '--',
      'go'
    ])
    expect(agentCommand('claude', 'go').args).toEqual(['--', 'go'])
    const refine = refineCommand('claude', 'plan', mcp, [], images).args
    expect(refine[refine.indexOf('--allowedTools') + 1]).toContain(',Read(//home/me/.kando/attachments/c.png)')
  })

  it("attaches only the user's own images to Codex's first message, before the prompt", () => {
    expect(agentCommand('codex', 'go', images).args).toEqual(['--image=/home/me/.kando/attachments/a.png', '--', 'go'])
    const refine = refineCommand('codex', 'plan', mcp, [], images).args
    expect(refine.slice(-3)).toEqual(['--image=/home/me/.kando/attachments/a.png', '--', 'plan'])
  })
})
