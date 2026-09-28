import { describe, expect, it } from 'vitest'
import { LineFramer } from './line-framer'

describe('LineFramer', () => {
  it('joins a line split across chunks and reports where each line ends', () => {
    const framer = new LineFramer(0)
    expect(framer.feed(0, '{"a":')).toEqual({ lines: [], gap: false })
    expect(framer.feed(5, '1}\n{"b":2}\n{"c"')).toEqual({
      lines: [{ text: '{"a":1}', end: 8 }, { text: '{"b":2}', end: 16 }],
      gap: false
    })
    expect(framer.flush()).toEqual({ text: '{"c"', end: 20 })
  })

  it('skips what it already read when a replayed buffer overlaps it', () => {
    const framer = new LineFramer(8)
    expect(framer.feed(0, '{"a":1}\n{"b":2}\n').lines).toEqual([{ text: '{"b":2}', end: 16 }])
    expect(framer.feed(8, '{"b":2}\n').lines).toEqual([])
  })

  it('drops the line a hole cut into and says output was lost', () => {
    const framer = new LineFramer(0)
    framer.feed(0, '{"a":')
    const { lines, gap } = framer.feed(40, 'tail of a lost line"}\n{"d":4}\n')
    expect(gap).toBe(true)
    expect(lines).toEqual([{ text: '{"d":4}', end: 70 }])
  })

  it('keeps skipping a cut line that spans several chunks', () => {
    const framer = new LineFramer(0)
    expect(framer.feed(10, 'no newline yet').lines).toEqual([])
    expect(framer.feed(24, ' still}\n{"e":5}\n').lines).toEqual([{ text: '{"e":5}', end: 40 }])
    expect(framer.flush()).toBeNull()
  })
})
