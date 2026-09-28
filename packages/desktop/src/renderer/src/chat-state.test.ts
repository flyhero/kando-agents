import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem, ConversationMessage, ConversationStage } from '@kando/protocol'
import {
  appendText,
  mergeItems,
  pathShortener,
  prependChatPage,
  receiveChatDelta,
  receiveChatItems,
  setChatPage,
  timeline,
  useChat
} from './chat-state'

const text = (id: string, value: string, stageId = 'chat-stage', revision = 1): ChatItem =>
  ({ id, stageId, revision, at: 0, kind: 'assistant', text: value, streaming: false }) as const
const stage = (id: string, mode: 'tui' | 'chat', startedAt: number): ConversationStage => ({
  id, conversationId: 'c', agent: 'claude', providerSessionId: null, sessionId: null, receivedSequence: 0,
  startedAt, endedAt: null, exitCode: null, mode
})
const message = (sequence: number, stageId: string, value: string): ConversationMessage => ({
  sequence, conversationId: 'c', stageId, role: 'user', agent: 'claude', text: value, eventKey: `k${sequence}`, complete: true, createdAt: 0
})

describe('chat items', () => {
  beforeEach(() => useChat.setState({}, true))

  it('replaces a known item where it stands and adds a new one last', () => {
    const merged = mergeItems([text('a', 'one'), text('b', 'two')], [text('a', 'one, revised', 'chat-stage', 2), text('c', 'three')])
    expect(merged.map((item) => item.kind === 'assistant' && item.text)).toEqual(['one, revised', 'two', 'three'])
  })

  it('streams text onto the item it names and ignores one it does not hold', () => {
    expect(appendText([text('a', 'he')], 'a', 'llo')).toEqual([text('a', 'hello')])
    expect(appendText([text('a', 'he')], 'missing', 'x')).toEqual([text('a', 'he')])
  })

  it('keeps only conversations a view watches, and puts an older page in front', () => {
    receiveChatItems('c', [text('a', 'ignored')])
    expect(useChat.getState().c).toBeUndefined()
    setChatPage('c', { items: [text('b', 'new')], before: 'stage-0' })
    receiveChatDelta('c', 'b', '!')
    prependChatPage('c', { items: [text('a', 'old'), text('b', 'stale')], before: null })
    expect(useChat.getState().c).toEqual({ items: [text('a', 'old'), text('b', 'new!')], before: null })
  })
})

describe('pathShortener', () => {
  it('reads paths relative to the project, naming the project when there are several', () => {
    expect(pathShortener(['/work/api'])('Edit /work/api/src/app.ts')).toBe('Edit src/app.ts')
    const both = pathShortener(['/work/api', '/work/api-web'])
    expect(both('/work/api-web/index.ts, /work/api/main.ts')).toBe('api-web/index.ts, api/main.ts')
    expect(both('/elsewhere/file')).toBe('/elsewhere/file')
  })
})

describe('timeline', () => {
  it('lays chat stages out as items and terminal stages as their recorded messages', () => {
    const stages = [stage('tui-1', 'tui', 1), stage('chat-stage', 'chat', 2)]
    const entries = timeline(stages, [message(1, 'tui-1', 'hello')], [text('a', 'reply'), text('late', 'next stage', 'unknown-stage')])
    expect(entries.map((entry) => (entry.kind === 'stage' ? `stage:${entry.stage.mode}` : entry.kind === 'item' ? `item:${entry.item.id}` : `message:${entry.message.text}`)))
      .toEqual(['stage:tui', 'message:hello', 'stage:chat', 'item:a', 'item:late'])
  })
})
