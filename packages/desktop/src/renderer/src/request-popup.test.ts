import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationRequest, Task } from '@kando/protocol'
import { newlyWaiting, popupKey, popupLabel, popupQueue } from './request-popup'

const request = (requestId: string, patch: Partial<ConversationRequest> = {}): ConversationRequest => ({
  requestId, kind: 'approval', tool: 'Bash', title: 'pnpm test', decisions: ['allow', 'deny'], open: 1, ...patch
})

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

const awaiting = (id: string, asked: ConversationRequest, patch: Partial<Conversation> = {}) =>
  conversation(id, { chat: { turn: 'awaiting', request: asked }, ...patch })

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
  awaitingInput: true,
  conversationId: null,
  plan: null,
  launch: {},
  createdAt: 0,
  updatedAt: 0,
  ...patch
})

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((each) => [each.id, each]))

describe('popupQueue', () => {
  it('offers the chats held up on the user, longest waiting first, a task chat under the task', () => {
    const conversations = byId([
      awaiting('b', request('r2'), { updatedAt: 20 }),
      awaiting('c', request('r3'), { taskId: 't1', updatedAt: 5 }),
      awaiting('a', request('r1'), { updatedAt: 10 }),
      conversation('idle')
    ])
    const queue = popupQueue({ conversations, tasks: byId([task('t1', { conversationId: 'c', updatedAt: 5 })]) }, new Set())
    expect(queue.map((entry) => [entry.conversationId, entry.title, entry.target.kind])).toEqual([
      ['c', '任务 t1', 'task'],
      ['a', '会话 a', 'conversation'],
      ['b', '会话 b', 'conversation']
    ])
  })

  it('leaves out a question asked in passing, a stopped agent, and what the user closed', () => {
    const asked = request('r1')
    const conversations = byId([
      conversation('passing', { chat: { turn: 'idle', request: request('q', { kind: 'question', tool: null, async: true }) } }),
      awaiting('stopped', request('r2'), { sessionId: null }),
      awaiting('closed', asked),
      awaiting('open', request('r3'))
    ])
    const queue = popupQueue({ conversations, tasks: {} }, new Set([popupKey('closed', asked)]))
    expect(queue.map((entry) => entry.conversationId)).toEqual(['open'])
  })

  it('brings a closed chat back once it asks for more', () => {
    const closed = new Set([popupKey('a', request('r1'))])
    const conversations = byId([awaiting('a', request('r1', { open: 2 }))])
    expect(popupQueue({ conversations, tasks: {} }, closed)).toHaveLength(1)
  })
})

describe('popupLabel', () => {
  it('names what is asked', () => {
    expect(popupLabel(request('r'))).toBe('等你允许')
    expect(popupLabel(request('r', { tool: 'ExitPlanMode' }))).toBe('计划待批准')
    expect(popupLabel(request('r', { kind: 'question', tool: null }))).toBe('有个问题')
  })
})

describe('newlyWaiting', () => {
  const running = conversation('a', { chat: { turn: 'running' } })
  const asked = awaiting('a', request('r1'))

  it('is news when a turn comes to wait on the user, or waits on more', () => {
    expect(newlyWaiting(byId([running]), byId([asked]))).toBe(true)
    expect(newlyWaiting(byId([asked]), byId([awaiting('a', request('r1', { open: 2 }))]))).toBe(true)
    expect(newlyWaiting(byId([asked]), byId([awaiting('a', request('r2'))]))).toBe(true)
  })

  it('is not news when nothing new waits', () => {
    expect(newlyWaiting(byId([asked]), byId([asked]))).toBe(false)
    expect(newlyWaiting(byId([asked]), byId([{ ...asked, updatedAt: 9 }]))).toBe(false)
    expect(newlyWaiting(byId([awaiting('a', request('r1', { open: 2 }))]), byId([asked]))).toBe(false)
    expect(newlyWaiting(byId([asked]), byId([running]))).toBe(false)
    // The list arriving on connect, and a question asked in passing.
    expect(newlyWaiting({}, byId([asked]))).toBe(false)
    const passing = conversation('a', { chat: { turn: 'idle', request: request('q', { kind: 'question', tool: null, async: true }) } })
    expect(newlyWaiting(byId([running]), byId([passing]))).toBe(false)
  })
})
