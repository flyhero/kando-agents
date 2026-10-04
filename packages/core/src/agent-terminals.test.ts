import { describe, expect, it } from 'vitest'
import type { AgentKind, ChatDecision, Terminal } from '@kando/protocol'
import { AgentTerminals } from './agent-terminals'

function setup(agent: AgentKind, answer: () => Promise<ChatDecision>, waitMs = 50) {
  const asked: string[] = []
  const started: string[] = []
  const terminals = new AgentTerminals(
    () => ({ agent, cwd: '/project' }),
    async (_id, cwd, command): Promise<Terminal> => {
      started.push(`${cwd} ${command}`)
      return { id: '00000000-0000-4000-8000-000000000001', sessionId: 's', cwd, title: command, createdAt: 0 }
    },
    (_id, command) => {
      asked.push(command)
      return answer()
    },
    waitMs
  )
  return { terminals, asked, started }
}

describe('AgentTerminals', () => {
  it('runs straight away for Claude, whose own permission prompt stands in front', async () => {
    const { terminals, asked, started } = setup('claude', async () => 'deny')
    expect(await terminals.run('c', 'pnpm dev')).toMatchObject({ outcome: 'started' })
    expect(asked).toEqual([])
    expect(started).toEqual(['/project pnpm dev'])
  })

  it('asks for Codex: once is once, every run is the conversation\'s', async () => {
    let decision: ChatDecision = 'allow'
    const { terminals, asked, started } = setup('codex', async () => decision)
    expect(await terminals.run('c', 'pnpm dev', '/other')).toMatchObject({ outcome: 'started' })
    expect(started).toEqual(['/other pnpm dev'])
    expect(await terminals.run('c', 'pnpm dev')).toMatchObject({ outcome: 'started' })
    expect(asked).toEqual(['pnpm dev', 'pnpm dev'])
    decision = 'allowForSession'
    await terminals.run('c', 'pnpm test')
    await terminals.run('c', 'pnpm lint')
    expect(asked).toEqual(['pnpm dev', 'pnpm dev', 'pnpm test'])
  })

  it('refuses what the user turns down, and tells the agent to wait for an answer that is slow', async () => {
    expect(await setup('codex', async () => 'deny').terminals.run('c', 'rm -rf build')).toEqual({ outcome: 'denied' })
    let answer: (decision: ChatDecision) => void = () => {}
    const slow = setup('codex', () => new Promise((resolve) => { answer = resolve }))
    expect(await slow.terminals.run('c', 'pnpm dev')).toEqual({ outcome: 'awaiting' })
    answer('allow')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The late yes counts for the agent's next try at the same command.
    expect(await slow.terminals.run('c', 'pnpm dev')).toMatchObject({ outcome: 'started' })
    expect(slow.asked).toEqual(['pnpm dev'])
  })
})
