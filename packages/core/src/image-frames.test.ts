import { describe, expect, it } from 'vitest'
import { stripImageBytes } from './image-frames'

describe('stripImageBytes', () => {
  it('empties image data wherever it sits, keeping the frame\'s shape', () => {
    const frame = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'x' }] }] },
      tool_use_result: { content: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }] }
    }
    expect(stripImageBytes(frame)).toEqual({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '' } }, { type: 'text', text: 'x' }] }] },
      tool_use_result: { content: [{ type: 'image', data: '', mimeType: 'image/jpeg' }] }
    })
  })

  it('returns a frame without images as it was', () => {
    const frame = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
    expect(stripImageBytes(frame)).toBe(frame)
  })
})
