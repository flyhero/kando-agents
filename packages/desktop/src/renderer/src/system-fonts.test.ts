import { describe, expect, it } from 'vitest'
import { cssFontFamily } from './system-fonts'

describe('cssFontFamily', () => {
  it('quotes a family name, escaping what would end the quote', () => {
    expect(cssFontFamily(' LXGW WenKai ')).toBe('"LXGW WenKai"')
    expect(cssFontFamily('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})
