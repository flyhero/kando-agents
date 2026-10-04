import { describe, expect, it } from 'vitest'
import { RpcError, type RpcConnection } from '@kando/protocol'
import { describeOutput, terminalToolsOverCore } from './mcp-terminal-tools'

const ID = '00000000-0000-4000-8000-000000000001'

// A core that answers each method as the test says, and records what it was asked.
function fakeCore(answers: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = []
  const rpc = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params])
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    }
  }
  // Only call is used; the rest of a connection never is.
  const withCore = async <T>(work: (connection: RpcConnection) => Promise<T>): Promise<T> => work(Object.assign(Object.create(null), rpc))
  return { calls, withCore }
}

const output = { id: ID, command: 'pnpm dev', output: 'ready', truncated: false, running: true, exitCode: null }

describe('terminal tools', () => {
  it('runs a command for the conversation and returns its first output', async () => {
    const core = fakeCore({ 'terminals.run': { outcome: 'started', terminal: { id: ID, cwd: '/p' } }, 'terminals.read': output })
    const tools = terminalToolsOverCore(core.withCore, 'conv', async () => {})
    const result = await tools.call('run', { command: 'pnpm dev' })
    expect(result.text).toContain(`标签 id：${ID}`)
    expect(result.text).toContain('ready')
    expect(core.calls[0]).toEqual(['terminals.run', { conversationId: 'conv', command: 'pnpm dev' }])
  })

  it('tells the agent to wait for the user, or that they said no', async () => {
    expect((await terminalToolsOverCore(fakeCore({ 'terminals.run': { outcome: 'awaiting' } }).withCore, 'conv').call('run', { command: 'x' })).text).toContain('等待用户确认')
    expect(await terminalToolsOverCore(fakeCore({ 'terminals.run': { outcome: 'denied' } }).withCore, 'conv').call('run', { command: 'x' })).toMatchObject({ isError: true })
  })

  it('says a terminal is not the conversation\'s in words the model can act on', async () => {
    const core = fakeCore({ 'terminals.read': new RpcError('nope', 0, 'terminal-not-found') })
    expect(await terminalToolsOverCore(core.withCore, 'conv').call('read', { id: ID })).toMatchObject({ isError: true, text: expect.stringContaining('没有这个终端') })
  })

  it('describes how a command stands', () => {
    expect(describeOutput({ ...output, running: false, exitCode: 1, truncated: true })).toBe('命令：pnpm dev\n状态：已结束，退出码 1\n（只保留了最后一部分输出）\n\nready')
    expect(describeOutput({ ...output, output: '' })).toContain('（还没有输出）')
  })
})
