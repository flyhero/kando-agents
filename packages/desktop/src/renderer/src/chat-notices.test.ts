import { describe, expect, it } from 'vitest'
import { noticeSummary, readableNotice } from './chat-notices'

describe('readableNotice', () => {
  it('says when a Claude usage limit lifts in local time', () => {
    const at = new Date()
    at.setHours(15, 4, 0, 0)
    const seconds = Math.floor(at.getTime() / 1000)
    expect(readableNotice(`Claude AI usage limit reached|${seconds}`)).toBe('Claude 的用量到了上限，15:04 恢复')
    expect(readableNotice('something else')).toBe('something else')
    expect(readableNotice('Error: RetriableError: [deadline_exceeded] bidi_append_deadline_exceeded: append seqno=14 (6 bytes) exceeded 60001ms deadline')).toBe('Cursor 连接超时，回复没有写完')
  })
})

describe('noticeSummary', () => {
  it('keeps a notice to its first line, saying when there is more', () => {
    expect(noticeSummary('Claude Code 异常退出（code 1）：\nstack\ntrace')).toEqual({ first: 'Claude Code 异常退出（code 1）：', more: true })
    expect(noticeSummary('对话上下文已压缩')).toEqual({ first: '对话上下文已压缩', more: false })
  })
})
