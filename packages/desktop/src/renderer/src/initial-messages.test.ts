import { beforeEach, describe, expect, it } from 'vitest'
import { createRpcClient, RpcRequest, type ChatImage, type Conversation, type RpcConnection } from '@kando/protocol'
import { acknowledgeInitialMessage, keepInitialMessage, restoredInitialMessages, sendInitialMessage, useInitialMessages } from './initial-messages'

const id = 'd964b86b-6a8c-4e23-9b79-dff4fdb4a3ad'
const image: ChatImage = { id: `${'a'.repeat(64)}.png`, width: 4, height: 3 }
const conversation: Conversation = { id, title: 'New', titleLocked: false, agent: 'cursor', workspacePath: '/workspace', projectPaths: [], managedWorkspace: true, sessionId: 'session', createdAt: 0, updatedAt: 0 }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function connection() {
  const sent: Array<ReturnType<typeof RpcRequest.parse>> = []
  const client = createRpcClient((frame) => sent.push(RpcRequest.parse(JSON.parse(frame))))
  const rpc: RpcConnection = { ...client, close() {}, closed: Promise.resolve(), features: ['deferred-conversation-start'] }
  const reply = (index: number, result: unknown) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, result }))
  const fail = (index: number) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[index]?.id, error: { code: -32000, message: 'startup failed' } }))
  return { rpc, sent, reply, fail }
}

beforeEach(() => useInitialMessages.setState({}, true))

describe('initial message delivery', () => {
  it('shows the message while startup waits and sends its images only after readiness', async () => {
    const { rpc, sent, reply } = connection()
    keepInitialMessage(id, 'look at this', [image])
    const ref = useInitialMessages.getState()[id]?.ref
    const delivery = sendInitialMessage(id, rpc)
    expect(useInitialMessages.getState()[id]).toMatchObject({ text: 'look at this', images: [image], phase: 'starting' })
    expect(sent.map((frame) => frame.method)).toEqual(['conversations.continue'])
    expect(sendInitialMessage(id, rpc)).toBe(delivery)
    expect(sent).toHaveLength(1)
    reply(0, conversation)
    await settle()
    expect(sent[1]).toMatchObject({ method: 'conversations.send', params: { id, text: 'look at this', images: [image.id], ref } })
    expect(useInitialMessages.getState()[id]?.phase).toBe('sending')
    reply(1, { ok: true })
    await delivery
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('keeps the text and images when startup fails and reuses the ref on retry', async () => {
    const { rpc, sent, reply, fail } = connection()
    keepInitialMessage(id, '', [image])
    const ref = useInitialMessages.getState()[id]?.ref
    const first = sendInitialMessage(id, rpc)
    fail(0)
    await first
    expect(sent).toHaveLength(1)
    expect(useInitialMessages.getState()[id]).toMatchObject({ phase: 'failed', error: 'startup failed', text: '', images: [image], ref })
    const retry = sendInitialMessage(id, rpc)
    reply(1, conversation)
    await settle()
    expect(sent[2]).toMatchObject({ params: { text: '', images: [image.id], ref } })
    reply(2, { ok: true })
    await retry
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('retains a stable ref if the send reply is lost', async () => {
    const { rpc, sent, reply, fail } = connection()
    keepInitialMessage(id, 'once', [])
    const first = sendInitialMessage(id, rpc)
    reply(0, conversation)
    await settle()
    fail(1)
    await first
    const retry = sendInitialMessage(id, rpc)
    reply(2, conversation)
    await settle()
    expect(sent[3]?.params).toEqual(sent[1]?.params)
    reply(3, { ok: true })
    await retry
  })

  it('recognizes a delivered message even if its RPC reply is lost', async () => {
    const { rpc, reply, fail } = connection()
    keepInitialMessage(id, 'once', [])
    const message = useInitialMessages.getState()[id]
    if (!message) throw new Error('missing pending message')
    const first = sendInitialMessage(id, rpc)
    reply(0, conversation)
    await settle()
    acknowledgeInitialMessage(id, [{ kind: 'user', id: `u:${message.ref}`, stageId: 'stage', revision: 0, at: 0, text: 'once', images: [] }])
    fail(1)
    await first
    expect(useInitialMessages.getState()[id]).toBeUndefined()
  })

  it('restores interrupted delivery for manual retry, including images', () => {
    keepInitialMessage(id, 'still here', [image])
    const saved = useInitialMessages.getState()
    const restored = restoredInitialMessages(JSON.stringify(saved))
    expect(restored[id]).toMatchObject({ text: 'still here', images: [image], ref: saved[id]?.ref, phase: 'failed' })
    expect(restoredInitialMessages('{')).toEqual({})
    expect(restoredInitialMessages(JSON.stringify({ [id]: { text: 'incomplete' } }))).toEqual({})
  })
})
