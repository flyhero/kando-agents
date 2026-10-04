import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import { itemKey } from './chat-state'
import { relayMessage } from './chat-message-relay'

const user = (id: string, text = '修复登录', stageId = 'stage-1'): Extract<ChatItem, { kind: 'user' }> => ({
  kind: 'user', id, stageId, revision: 1, at: 100, text, images: []
})

describe('relayMessage', () => {
  it('waits for a newly delivered message, even when history has the same text', () => {
    const old = user('old')
    const sent = { text: old.text, images: [], known: new Set([itemKey(old)]) }
    expect(relayMessage([old], sent)).toBeNull()
    const delivered = user('new')
    expect(relayMessage([old, delivered], sent)).toBe(delivered)
    expect(relayMessage([old, user('other', '不同消息')], sent)).toBeNull()
  })

  it('matches images and quotes rather than just a repeated body', () => {
    const quote = '> 引用原文\n\n继续处理'
    const delivered = { ...user('new', quote), images: [{ id: 'photo.png', width: 8, height: 8 }] }
    const sent = { text: quote, images: ['photo.png'], known: new Set<string>() }
    expect(relayMessage([user('body', '继续处理'), delivered], sent)).toBe(delivered)
    expect(relayMessage([{ ...delivered, images: [] }], sent)).toBeNull()
    expect(relayMessage([{ ...delivered, images: [{ id: 'other.png', width: 8, height: 8 }] }], sent)).toBeNull()
  })

  it('allows a restarted agent to reuse an item id in a new stage', () => {
    const old = user('1')
    const delivered = user('1', old.text, 'stage-2')
    expect(relayMessage([old, delivered], { text: old.text, images: [], known: new Set([itemKey(old)]) })).toBe(delivered)
  })
})
