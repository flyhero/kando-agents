import { describe, expect, it } from 'vitest'
import { createLineDecoder } from './daemon-protocol'

describe('createLineDecoder', () => {
  it('keeps a character whole when its bytes arrive in different chunks', () => {
    const lines: string[] = []
    const decode = createLineDecoder((line) => lines.push(line))
    const bytes = Buffer.from('{"text":"中文"}\n{"b":1}\n')
    // Split inside the first character: 中 is three bytes in UTF-8.
    const cut = bytes.indexOf(Buffer.from('中')) + 1
    decode(bytes.subarray(0, cut))
    decode(bytes.subarray(cut))
    expect(lines).toEqual(['{"text":"中文"}', '{"b":1}'])
  })
})
