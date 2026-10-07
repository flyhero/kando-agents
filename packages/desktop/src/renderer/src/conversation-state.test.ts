import { describe, expect, it } from 'vitest'
import type { Conversation } from '@kando/protocol'
import { conversationGlyph, conversationState, timeAgo } from './conversation-state'

const base: Conversation = {
  id: '11111111-1111-4111-8111-111111111111', title: 't', titleLocked: false, agent: 'claude', workspacePath: '/w',
  projectPaths: [], managedWorkspace: true, sessionId: null, createdAt: 0, updatedAt: 0
}
const label = (patch: Partial<Conversation>) => conversationState({ ...base, ...patch })

describe('conversationState', () => {
  it('tells an agent that waits on the user from one that works', () => {
    expect(label({ sessionId: 's', chat: { turn: 'running' } }).label).toBe('运行中')
    expect(label({ sessionId: 's', chat: { turn: 'awaiting' } }).label).toBe('等待确认')
  })

  it('calls a conversation idle whether or not its agent is up, unless it crashed', () => {
    expect(label({ sessionId: 's', chat: { turn: 'idle' } })).toMatchObject({ label: '空闲', running: false })
    expect(label({ sessionId: 's', chat: { turn: 'idle', request: { requestId: 'async:c1', kind: 'question', tool: null, title: '?', decisions: [], open: 1, async: true } } })).toMatchObject({ label: '等你回答', running: false })
    expect(label({}).label).toBe('空闲')
    expect(label({ lastExit: null }).label).toBe('空闲')
    expect(label({ lastExit: { code: null, at: 1 } }).label).toBe('空闲')
    expect(label({ lastExit: { code: 0, at: 1 } }).label).toBe('空闲')
    expect(label({ lastExit: { code: 1, at: 1 } })).toMatchObject({ label: '异常退出', failed: true, detail: 'Agent 异常退出（code 1），发消息会重新启动它' })
  })
})

describe('conversationGlyph', () => {
  const glyph = (patch: Partial<Conversation>, unseen = false) => conversationGlyph({ ...base, ...patch }, unseen)

  it('puts what waits on the user before an agent at work, and that before a failure', () => {
    expect(glyph({ sessionId: 's', chat: { turn: 'awaiting' } })).toBe('awaiting')
    expect(glyph({ sessionId: 's', chat: { turn: 'running' } })).toBe('running')
    expect(glyph({ lastExit: { code: 1, at: 1 } }, true)).toBe('failed')
  })

  it('marks a finished turn the user has not seen, and otherwise nothing going on', () => {
    expect(glyph({ sessionId: 's', chat: { turn: 'idle' } }, true)).toBe('unseen')
    expect(glyph({ sessionId: 's', chat: { turn: 'idle' } })).toBe('idle')
  })
})

describe('timeAgo', () => {
  it('says how long ago in the list\'s short words, and the date past a week', () => {
    const now = new Date(2026, 8, 29, 12, 0).getTime()
    expect(timeAgo(now - 20_000, now)).toBe('刚刚')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 天前')
    expect(timeAgo(new Date(2026, 8, 1).getTime(), now)).toBe('9月1日')
  })
})
