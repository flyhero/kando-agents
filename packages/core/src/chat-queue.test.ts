import { describe, expect, it } from 'vitest'
import { ChatQueue } from './chat-queue'

describe('ChatQueue', () => {
  it('holds one message, replaced by a newer one, until it goes out', () => {
    const queue = new ChatQueue()
    queue.set('first', 'ref-1')
    queue.set('second', 'ref-2')
    expect(queue.next()).toEqual({ text: 'second', ref: 'ref-2' })
    queue.sent('ref-1')
    expect(queue.view).toEqual({ text: 'second', held: false })
    queue.sent('ref-2')
    expect(queue.view).toBeNull()
  })

  it('does not send after a turn that did not complete', () => {
    const queue = new ChatQueue()
    queue.set('later', 'ref-1')
    queue.turnEnded('failed')
    expect(queue.next()).toBeNull()
    expect(queue.view).toEqual({ text: 'later', held: true })
    queue.set(null, undefined)
    expect(queue.view).toBeNull()
  })
})
