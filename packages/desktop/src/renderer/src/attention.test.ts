import { describe, expect, it } from 'vitest'
import type { Conversation, Task } from '@kando/protocol'
import { attentionCount, noticesBetween, type Snapshot } from './attention'

const conversation = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `会话 ${id}`,
  titleLocked: false,
  agent: 'claude',
  workspacePath: '/w',
  projectPaths: [],
  managedWorkspace: true,
  sessionId: 's',
  createdAt: 0,
  updatedAt: 0,
  lastExit: null,
  chat: { turn: 'idle' },
  taskId: null,
  ...patch
})

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `任务 ${id}`,
  details: '',
  status: 'running',
  repos: [],
  dependsOn: [],
  agent: 'claude',
  derivedFrom: null,
  abandonReason: null,
  source: null,
  sourceSnapshot: null,
  images: [],
  awaitingInput: false,
  conversationId: null,
  plan: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch
})

const snapshot = (conversations: Conversation[] = [], tasks: Task[] = [], unseen: string[] = []): Snapshot => ({
  conversations: Object.fromEntries(conversations.map((each) => [each.id, each])),
  tasks: Object.fromEntries(tasks.map((each) => [each.id, each])),
  unseen: Object.fromEntries(unseen.map((id) => [id, true]))
})

describe('attentionCount', () => {
  it('counts agents waiting, turns unseen and tasks awaiting, a task chat once', () => {
    const s = snapshot(
      [
        conversation('a', { chat: { turn: 'awaiting' } }),
        conversation('b'),
        conversation('c', { taskId: 't1', chat: { turn: 'awaiting' } }),
        conversation('d', { sessionId: null, chat: { turn: 'awaiting' } })
      ],
      [task('t1', { awaitingInput: true, conversationId: 'c' }), task('t2', { awaitingInput: true }), task('t3')],
      ['b']
    )
    expect(attentionCount(s)).toBe(4)
    expect(attentionCount(snapshot())).toBe(0)
  })
})

describe('noticesBetween', () => {
  it('says nothing of conversations first seen or unchanged', () => {
    const a = conversation('a', { chat: { turn: 'running' } })
    expect(noticesBetween(snapshot(), snapshot([a]))).toEqual([])
    expect(noticesBetween(snapshot([a]), snapshot([a]))).toEqual([])
    expect(noticesBetween(snapshot([a]), snapshot([conversation('a', { chat: { turn: 'running' } })]))).toEqual([])
  })

  it('tells of an agent waiting, a turn over and a crash, each once', () => {
    const running = conversation('a', { chat: { turn: 'running' } })
    const awaiting = conversation('a', { chat: { turn: 'awaiting' } })
    const idle = conversation('a')
    const gone = conversation('a', { sessionId: null, lastExit: { code: 1, at: 5 } })
    expect(noticesBetween(snapshot([running]), snapshot([awaiting]))).toEqual([
      { title: '会话 a', body: 'agent 在等你允许或回答', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([awaiting]), snapshot([idle]))).toEqual([
      { title: '会话 a', body: 'agent 这一轮做完了', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([running]), snapshot([gone]))).toEqual([
      { title: '会话 a', body: 'agent 异常退出（code 1），发消息会重新启动它', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([gone]), snapshot([conversation('a', { sessionId: null, lastExit: { code: 1, at: 5 } })]))).toEqual([])
  })

  it('names a task chat after the task and leads to it', () => {
    const before = conversation('c', { taskId: 't1', chat: { turn: 'running' } })
    const after = conversation('c', { taskId: 't1', chat: { turn: 'idle' } })
    expect(noticesBetween(snapshot([before], [task('t1', { conversationId: 'c' })]), snapshot([after], [task('t1', { conversationId: 'c' })]))).toEqual([
      { title: '任务 t1', body: 'agent 这一轮做完了', target: { kind: 'task', id: 't1' } }
    ])
  })
})
