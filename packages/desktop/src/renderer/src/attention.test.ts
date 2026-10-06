import { describe, expect, it } from 'vitest'
import type { Conversation, ScheduledRun, Task } from '@kando/protocol'
import { actionableItems, attentionCount, noticesBetween, quickApproval, type Snapshot } from './attention'

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

  it("counts a routine's unread runs through the routine, not through its conversations", () => {
    const routineId = '00000000-0000-4000-8000-000000000101'
    const theirs = conversation('r', { routineId, chat: { turn: 'awaiting' } })
    const base = snapshot([theirs, conversation('b')], [], ['b', 'r'])
    const routine = {
      id: routineId, title: '日报', enabled: true, schedule: { kind: 'daily' as const, time: '09:00' },
      target: { kind: 'new' as const, agent: 'claude' as const, projectPaths: [], text: 'x' },
      nextRunAt: null, lastFiredAt: null, unread: 2, lastRun: null, createdAt: 0, updatedAt: 0
    }
    expect(attentionCount({ ...base, routines: [routine] })).toBe(3)
    expect(attentionCount(base)).toBe(1)
    // Its conversation finishing is told of through the routine, not here.
    const going = { ...base, conversations: { ...base.conversations, r: conversation('r', { routineId, chat: { turn: 'running' } }) } }
    expect(noticesBetween(going, base)).toEqual([])
  })
})

describe('actionableItems', () => {
  it('aggregates all four reasons in priority order, counting a task chat once', () => {
    const items = actionableItems(snapshot([
      conversation('approval', { taskId: 'approval-task', chat: { turn: 'awaiting' } }),
      conversation('crash', { sessionId: null, lastExit: { code: 2, at: 5 } }),
      conversation('unread'),
      conversation('question', { chat: { turn: 'awaiting' }, updatedAt: 10 })
    ], [
      task('approval-task', { conversationId: 'approval', awaitingInput: true }),
      task('review', { status: 'review' }), task('reply', { awaitingInput: true })
    ], ['unread']))
    expect(items.map((item) => [item.target.id, item.reasons])).toEqual([
      ['approval-task', ['awaiting']], ['question', ['awaiting']], ['crash', ['crashed']], ['review', ['review']], ['reply', ['reply']]
    ])
  })

  it('keeps multiple reasons on one subject and links by either ownership field', () => {
    const items = actionableItems(snapshot([
      conversation('a', { taskId: 't', sessionId: null, lastExit: { code: 1, at: 5 } }),
      conversation('b', { chat: { turn: 'awaiting' } })
    ], [task('t', { status: 'review', awaitingInput: true }), task('u', { conversationId: 'b' })]))
    expect(items).toEqual([
      expect.objectContaining({ target: { kind: 'task', id: 'u' }, conversationId: 'b', reasons: ['awaiting'] }),
      expect.objectContaining({ target: { kind: 'task', id: 't' }, conversationId: 'a', reasons: ['crashed', 'review'] })
    ])
  })

  it('carries what a waiting agent asks, and answers in the list only a plain approval', () => {
    const bash = { requestId: 'r1', kind: 'approval' as const, tool: 'Bash', title: 'git commit -m x', decisions: ['allow' as const, 'deny' as const], open: 2 }
    const items = actionableItems(snapshot([
      conversation('a', { chat: { turn: 'awaiting', request: bash } }),
      conversation('b', { sessionId: null, lastExit: { code: 1, at: 5 }, chat: { turn: 'awaiting', request: bash } })
    ]))
    expect(items.map((item) => [item.target.id, item.request?.requestId ?? null])).toEqual([['a', 'r1'], ['b', null]])
    expect(quickApproval(bash)).toBe(true)
    expect(quickApproval({ ...bash, tool: 'ExitPlanMode' })).toBe(false)
    expect(quickApproval({ ...bash, decisions: ['deny'] })).toBe(false)
    expect(quickApproval({ ...bash, kind: 'question', tool: null, decisions: [] })).toBe(false)
    expect(quickApproval(null)).toBe(false)
  })

  it('excludes done, abandoned and deleted tasks and their conversations', () => {
    expect(actionableItems(snapshot([
      conversation('done', { taskId: 'done', chat: { turn: 'awaiting' } }),
      conversation('abandoned', { chat: { turn: 'awaiting' } }),
      conversation('deleted', { taskId: 'deleted', sessionId: null, lastExit: { code: 1, at: 5 } })
    ], [
      task('done', { status: 'done', awaitingInput: true, conversationId: 'done' }),
      task('abandoned', { status: 'abandoned', awaitingInput: true, conversationId: 'abandoned' })
    ]))).toEqual([])
  })

  it('excludes normal exits, active agents with old failures, stopped requests and dependency waits', () => {
    const chats = [
      conversation('normal', { sessionId: null, lastExit: { code: 0, at: 5 } }),
      conversation('stopped', { sessionId: null, lastExit: { code: null, at: 5 } }),
      conversation('running', { chat: { turn: 'running' }, lastExit: { code: 1, at: 5 } }),
      conversation('stale', { sessionId: null, chat: { turn: 'awaiting' } })
    ]
    expect(actionableItems(snapshot(chats, [task('blocked', { status: 'pending', dependsOn: ['dependency'] })], chats.map((c) => c.id)))).toEqual([])
  })

  it('sorts each priority oldest first with a stable id tiebreaker', () => {
    const items = actionableItems(snapshot([], [
      task('c', { status: 'review', updatedAt: 20 }), task('b', { status: 'review', updatedAt: 10 }),
      task('a', { status: 'review', updatedAt: 10 })
    ]))
    expect(items.map((item) => item.target.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not change limited-core aggregation when a task chat is opened', () => {
    const t = task('t', { conversationId: 'a', awaitingInput: true })
    const before = snapshot([], [t])
    const after = snapshot([conversation('a', { taskId: 't', chat: { turn: 'awaiting' } })], [t])
    expect(actionableItems(after, false)).toEqual(actionableItems(before, false))
    expect(actionableItems(after)[0]?.reasons).toEqual(['awaiting'])
  })

  it('updates reasons after answering, resuming, review completion and deletion', () => {
    const t = task('t', { conversationId: 'a', awaitingInput: true })
    const c = conversation('a', { taskId: 't', chat: { turn: 'awaiting' } })
    expect(actionableItems(snapshot([c], [t]))[0]?.reasons).toEqual(['awaiting'])
    expect(actionableItems(snapshot([{ ...c, chat: { turn: 'running' } }], [t]))).toEqual([])
    expect(actionableItems(snapshot([{ ...c, chat: { turn: 'idle' } }], [t]))[0]?.reasons).toEqual(['reply'])
    expect(actionableItems(snapshot([c], [{ ...t, status: 'review' }]))[0]?.reasons).toEqual(['awaiting', 'review'])
    expect(actionableItems(snapshot([{ ...c, chat: { turn: 'idle' } }], [{ ...t, status: 'review', awaitingInput: false }]))[0]?.reasons).toEqual(['review'])
    expect(actionableItems(snapshot([c], [{ ...t, status: 'done' }]))).toEqual([])
    expect(actionableItems(snapshot([c]))).toEqual([])
    const crash = conversation('free', { sessionId: null, lastExit: { code: 1, at: 5 } })
    expect(actionableItems(snapshot([crash]))).toHaveLength(1)
    expect(actionableItems(snapshot([{ ...crash, sessionId: 'new', chat: { turn: 'running' } }]))).toEqual([])
    expect(actionableItems(snapshot())).toEqual([])
  })

  it('excludes automatic quota resumes until they fail or are cancelled, without hiding approvals', () => {
    const t = task('t', { conversationId: 'a', awaitingInput: true })
    const c = conversation('a', { taskId: 't' })
    const run: ScheduledRun = {
      id: 'run', target: { kind: 'resume', conversationId: 'a', stageId: 'stage', itemId: 'limit' },
      title: 'resume', agent: 'claude', notBefore: null, resetsAt: 10, status: 'waiting',
      conversationId: null, attempts: 0, error: null, createdAt: 0, settledAt: null
    }
    const s = { ...snapshot([c], [t]), schedules: [run] }
    expect(actionableItems(s)).toEqual([])
    expect(actionableItems({ ...s, schedules: [{ ...run, status: 'starting' }] })).toEqual([])
    expect(actionableItems({ ...s, schedules: [{ ...run, status: 'cancelled' }] })[0]?.reasons).toEqual(['reply'])
    expect(actionableItems({ ...s, schedules: [{ ...run, status: 'failed' }] })[0]?.reasons).toEqual(['reply'])
    expect(actionableItems({ ...s, conversations: { a: { ...c, chat: { turn: 'awaiting' } } } })[0]?.reasons).toEqual(['awaiting'])
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
      { title: '会话 a', body: 'Agent 在等你允许或回答', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([awaiting]), snapshot([idle]))).toEqual([
      { title: '会话 a', body: 'Agent 这一轮做完了', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([running]), snapshot([gone]))).toEqual([
      { title: '会话 a', body: 'Agent 异常退出（code 1），发消息会重新启动它', target: { kind: 'conversation', id: 'a' } }
    ])
    expect(noticesBetween(snapshot([gone]), snapshot([conversation('a', { sessionId: null, lastExit: { code: 1, at: 5 } })]))).toEqual([])
  })

  it('names a task chat after the task and leads to it', () => {
    const before = conversation('c', { taskId: 't1', chat: { turn: 'running' } })
    const after = conversation('c', { taskId: 't1', chat: { turn: 'idle' } })
    expect(noticesBetween(snapshot([before], [task('t1', { conversationId: 'c' })]), snapshot([after], [task('t1', { conversationId: 'c' })]))).toEqual([
      { title: '任务 t1', body: 'Agent 这一轮做完了', target: { kind: 'task', id: 't1' } }
    ])
  })
})
