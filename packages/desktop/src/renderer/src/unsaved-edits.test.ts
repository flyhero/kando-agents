import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRpcClient, type RpcConnection } from '@kando/protocol'
import { useCore } from './core-store'
import { saveTaskText, startUnsavedEditRetries, unsavedTaskText } from './unsaved-edits'

type Sent = { id: number; method: string; params: { id: string; title?: string; details?: string } }

// A connection whose requests the test answers by hand.
function fakeCore() {
  const sent: Sent[] = []
  const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
  const connection: RpcConnection = { ...client, close: () => {}, closed: new Promise(() => {}) }
  const task = (id: string, details: string) => ({
    id, title: 't', details, status: 'pending', repos: [], dependsOn: [], agent: null, sessionId: null, createdAt: 0, updatedAt: 0
  })
  return {
    connection,
    // Earlier tests' leftovers are resent too, so pick requests by task.
    sentFor: (taskId: string) => sent.filter((request) => request.params.id === taskId),
    ok: (request: Sent) =>
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: task(request.params.id, request.params.details ?? '') })),
    refuse: (request: Sent, reason: string) =>
      client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: reason, data: { reason } } }))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('unsaved task edits', () => {
  beforeAll(() => startUnsavedEditRetries())
  beforeEach(() => useCore.setState({ rpc: null, error: null }))

  it('keeps an edit made while core is away and sends it once core is back', async () => {
    saveTaskText('t1', 'details', 'offline draft')
    await settle()
    expect(unsavedTaskText('t1', 'details')).toBe('offline draft')

    const core = fakeCore()
    useCore.setState({ rpc: core.connection })
    await settle()
    const [request] = core.sentFor('t1')
    expect(request).toMatchObject({ method: 'tasks.update', params: { id: 't1', details: 'offline draft' } })
    core.ok(request!)
    await settle()
    expect(unsavedTaskText('t1', 'details')).toBeUndefined()
  })

  it('keeps an edit whose request dies with the connection', async () => {
    const core = fakeCore()
    useCore.setState({ rpc: core.connection })
    saveTaskText('t2', 'title', 'renamed')
    core.connection.failAll(new Error('connection closed'))
    await settle()
    expect(unsavedTaskText('t2', 'title')).toBe('renamed')
  })

  it('sends the latest text again when typing went on during a save', async () => {
    const core = fakeCore()
    useCore.setState({ rpc: core.connection })
    saveTaskText('t3', 'details', 'a')
    saveTaskText('t3', 'details', 'ab')
    core.ok(core.sentFor('t3')[0]!)
    await settle()
    expect(core.sentFor('t3').map((request) => request.params.details)).toEqual(['a', 'ab'])
    core.ok(core.sentFor('t3')[1]!)
    await settle()
    expect(unsavedTaskText('t3', 'details')).toBeUndefined()
  })

  it('drops an edit core refuses, quietly when the task is gone', async () => {
    const core = fakeCore()
    useCore.setState({ rpc: core.connection })
    saveTaskText('gone', 'details', 'x')
    core.refuse(core.sentFor('gone')[0]!, 'task-not-found')
    await settle()
    expect(unsavedTaskText('gone', 'details')).toBeUndefined()
    expect(useCore.getState().error).toBeNull()

    saveTaskText('t4', 'title', 'y')
    core.refuse(core.sentFor('t4')[0]!, 'invalid-params')
    await settle()
    expect(unsavedTaskText('t4', 'title')).toBeUndefined()
    expect(useCore.getState().error).toContain('没能保存')
  })
})
