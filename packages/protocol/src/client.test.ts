import { describe, expect, it } from 'vitest'
import { RpcError, createRpcClient } from './client'

describe('createRpcClient', () => {
  it('resolves results and rejects errors by request id', async () => {
    const sent: string[] = []
    const client = createRpcClient((frame) => sent.push(frame))

    const ok = client.call('tasks.delete', { id: 'a' })
    const failed = client.call('tasks.get', { id: 'b' })
    const [first, second] = sent.map((frame) => JSON.parse(frame))

    client.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: second.id,
        error: { code: -32000, message: 'nope', data: { reason: 'task-not-found' } }
      })
    )
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { ok: true } }))

    await expect(ok).resolves.toEqual({ ok: true })
    await expect(failed).rejects.toMatchObject({ reason: 'task-not-found' })
    await expect(failed).rejects.toBeInstanceOf(RpcError)
  })

  it('ignores notifications it does not know about', () => {
    const client = createRpcClient(() => {})
    const seen: string[] = []
    client.on('tasks.deleted', ({ id }) => seen.push(id))

    client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'future.thing', params: {} }))
    client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'tasks.deleted', params: { id: 'x' } }))

    expect(seen).toEqual(['x'])
  })
})
