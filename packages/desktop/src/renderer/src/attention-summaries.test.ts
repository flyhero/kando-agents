import { describe, expect, it } from 'vitest'
import { createRpcClient, rpcSchemas, type Conversation, type RpcConnection } from '@kando/protocol'
import { attentionSummaryMode, fetchAttentionSummaries, replaySummaryChanges } from './attention-summaries'

const chat: Conversation = {
  id: '00000000-0000-4000-8000-000000000001', title: 'Task chat', titleLocked: true,
  agent: 'claude', workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false,
  sessionId: 'session', createdAt: 1, updatedAt: 1, taskId: 'task', chat: { turn: 'awaiting' }
}

function connection(features = ['task-conversation-summaries']) {
  const sent: Array<{ id: number; method: string; params: unknown }> = []
  const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
  const rpc: RpcConnection = { ...client, features, close: () => {}, closed: new Promise(() => {}) }
  const answer = (result: unknown) => rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent.at(-1)?.id, result }))
  return { rpc, sent, answer }
}

describe('attention summaries', () => {
  it('keeps the list opt-in and validates the optional parameter', () => {
    expect(rpcSchemas['conversations.list'].params.parse({})).toEqual({})
    expect(rpcSchemas['conversations.list'].params.parse({ includeTasks: true })).toEqual({ includeTasks: true })
    expect(rpcSchemas['conversations.list'].params.safeParse({ includeTasks: 'yes' }).success).toBe(false)
  })

  it('loads task summaries on first connection and again after reconnecting', async () => {
    for (const turn of ['awaiting', 'idle'] as const) {
      const { rpc, sent, answer } = connection()
      const loading = fetchAttentionSummaries(rpc)
      expect(sent[0]).toMatchObject({ method: 'conversations.list', params: { includeTasks: true } })
      answer([{ ...chat, chat: { turn } }])
      expect((await loading)[chat.id]?.chat?.turn).toBe(turn)
    }
  })

  it('never sends an unsupported parameter to an older core', async () => {
    const { rpc, sent, answer } = connection([])
    const loading = fetchAttentionSummaries(rpc)
    expect(attentionSummaryMode(rpc)).toBe('limited')
    expect(sent[0]?.params).toEqual({})
    answer([])
    expect(await loading).toEqual({})
  })

  it('keeps changes and deletions arriving while a snapshot is loading', async () => {
    const { rpc, answer } = connection()
    const loading = fetchAttentionSummaries(rpc)
    const deleted = { ...chat, id: '00000000-0000-4000-8000-000000000002' }
    const next = { ...chat, chat: { turn: 'running' as const }, updatedAt: 2 }
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'conversations.changed', params: { conversation: next } }))
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', method: 'conversations.deleted', params: { id: deleted.id } }))
    answer([chat, deleted])
    expect(await loading).toEqual({ [chat.id]: next })
  })

  it('reports a load failure and allows retrying with a fresh snapshot', async () => {
    const { rpc, sent, answer } = connection()
    const loading = fetchAttentionSummaries(rpc)
    const rejection = expect(loading).rejects.toThrow('snapshot failed')
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent.at(-1)?.id, error: { code: -32000, message: 'snapshot failed' } }))
    await rejection
    const retry = fetchAttentionSummaries(rpc)
    answer([chat])
    expect((await retry)[chat.id]).toEqual(chat)
  })

  it('replays task deletions and status updates instead of stale initial state', () => {
    expect(replaySummaryChanges([{ id: 'a', status: 'running' }, { id: 'b', status: 'review' }], new Map([
      ['a', { id: 'a', status: 'review' }], ['b', null]
    ]))).toEqual({ a: { id: 'a', status: 'review' } })
  })
})
