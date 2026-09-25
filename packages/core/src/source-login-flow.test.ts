import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fakeConnection, tick, until } from './fake-connection'
import { LoginFlows } from './source-login-flow'

const target = { provider: 'demo', instance: 'default' }

describe('LoginFlows', () => {
  it('asks only the client that started the flow, and only it may answer', async () => {
    const flows = new LoginFlows()
    const owner = fakeConnection()
    const stranger = fakeConnection()
    const flowId = flows.start(owner, target, randomUUID(), async (session) => `user:${await session.prompt({ kind: 'text', label: 'Name' })}`)

    const prompt = await until(() => owner.last('sources.loginPrompt'))
    expect(prompt).toMatchObject({ flowId, prompt: { kind: 'text', label: 'Name' } })
    expect(stranger.notes).toEqual([])
    expect(() => flows.answer(stranger, flowId, prompt.promptId, 'eve')).toThrow(/no such sign-in/)
    expect(() => flows.answer(owner, flowId, 'stale', 'ann')).toThrow(/no longer open/)

    flows.answer(owner, flowId, prompt.promptId, 'ann')
    expect(await until(() => owner.last('sources.loginFinished'))).toEqual({
      flowId,
      provider: 'demo',
      instance: 'default',
      account: 'user:ann',
      problem: null
    })
  })

  it('uses the id the client picked, so a prompt that beats the reply still finds its flow', async () => {
    const flows = new LoginFlows()
    const owner = fakeConnection()
    const flowId = randomUUID()
    expect(flows.start(owner, target, flowId, (session) => session.prompt({ kind: 'text', label: 'x' }))).toBe(flowId)
    expect((await until(() => owner.last('sources.loginPrompt'))).flowId).toBe(flowId)
    expect(() => flows.start(owner, { ...target, instance: 'second' }, flowId, async () => 'x')).toThrow(/taken/)
  })

  it('allows one sign-in per instance at a time', async () => {
    const flows = new LoginFlows()
    const owner = fakeConnection()
    flows.start(owner, target, randomUUID(), (session) => session.prompt({ kind: 'secret', label: 'Token' }))
    expect(() => flows.start(fakeConnection(), target, randomUUID(), async () => 'x')).toThrow(/already in progress/)
    expect(() => flows.start(owner, { ...target, instance: 'second' }, randomUUID(), async () => 'x')).not.toThrow()
  })

  it('ends when its client goes away, when it is cancelled, or when nobody answers', async () => {
    const flows = new LoginFlows(20)
    let committed = false
    const commit = async (session: { prompt(prompt: { kind: 'text'; label: string }): Promise<string> }) => {
      await session.prompt({ kind: 'text', label: 'x' })
      committed = true
      return 'x'
    }

    const leaving = fakeConnection()
    flows.start(leaving, target, randomUUID(), commit)
    await until(() => leaving.last('sources.loginPrompt'))
    leaving.close()
    expect((await until(() => leaving.last('sources.loginFinished'))).problem?.code).toBe('login-cancelled')

    const cancelling = fakeConnection()
    const cancelled = flows.start(cancelling, target, randomUUID(), commit)
    await until(() => cancelling.last('sources.loginPrompt'))
    flows.cancel(cancelling, cancelled)
    expect((await until(() => cancelling.last('sources.loginFinished'))).problem?.code).toBe('login-cancelled')

    const idle = fakeConnection()
    flows.start(idle, target, randomUUID(), commit)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await tick()
    expect((await until(() => idle.last('sources.loginFinished'))).problem?.code).toBe('login-timeout')
    expect(committed).toBe(false)
    // The instance is free again once each flow ended.
    expect(() => flows.start(fakeConnection(), target, randomUUID(), async () => 'x')).not.toThrow()
  })
})
