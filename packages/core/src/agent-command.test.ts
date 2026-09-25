import { describe, expect, it } from 'vitest'
import { agentCommand, refineCommand } from './agent-command'

const images = {
  attached: ['/home/me/.kando/attachments/a.png', '/home/me/odd,name/b.png'],
  all: ['/home/me/.kando/attachments/a.png', '/home/me/odd,name/b.png', '/home/me/.kando/attachments/c.png']
}
const mcp = { command: 'kando', args: ['mcp'] }

describe('agent commands with images', () => {
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
