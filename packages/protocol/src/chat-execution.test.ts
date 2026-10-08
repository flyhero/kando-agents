import { describe, expect, it } from 'vitest'
import { ChatItem } from './chat'

const tool = { kind: 'tool', id: 'command', stageId: 'stage', revision: 1, at: 0, name: 'commandExecution', title: 'rg missing .', input: null, output: null, status: 'failed' }

describe('command execution compatibility', () => {
  it('accepts older messages without independent execution information', () => {
    expect(ChatItem.parse(tool)).toMatchObject({ status: 'failed' })
  })

  it.each([0, 1, 2, null])('preserves exit %s without changing the legacy tool status', (exitCode) => {
    const execution = { status: 'completed', exitCode }
    expect(ChatItem.parse({ ...tool, execution })).toMatchObject({ status: 'failed', execution })
  })
})
