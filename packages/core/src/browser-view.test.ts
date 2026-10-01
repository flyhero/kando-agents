import { describe, expect, it } from 'vitest'
import { FrameGate } from './browser-view'

describe('FrameGate', () => {
  it('lets two frames through, then one more per acknowledgement', () => {
    const gate = new FrameGate()
    expect(gate.offer(1)).toBe(true)
    expect(gate.offer(2)).toBe(true)
    expect(gate.offer(3)).toBe(false)
    gate.ack(1)
    expect(gate.offer(4)).toBe(true)
    // An ack for a frame that was never sent changes nothing.
    gate.ack(9)
    expect(gate.offer(5)).toBe(false)
  })
})
