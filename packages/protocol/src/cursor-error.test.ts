import { expect, it } from 'vitest'
import { cursorProviderError } from './cursor-error'

const deadline = 'Error: RetriableError: [deadline_exceeded] bidi_append_deadline_exceeded: append seqno=14 (6 bytes) exceeded 60001ms deadline'

it('explains a timeout that arrived after a real reply', () => {
  expect(cursorProviderError(`先看一下分支。\n\n${deadline}`)).toMatchObject({
    code: 'deadline_exceeded',
    rest: '先看一下分支。',
    summary: 'Cursor 连接超时，回复没有写完'
  })
})

it('explains a provider error that is the whole reply', () => {
  expect(cursorProviderError('\n\nError: RetriableError: [resource_exhausted] Error')?.summary).toBe('Cursor 这一会儿忙不过来，或额度用完了')
  expect(cursorProviderError('Error: ConnectError: [unavailable] dropped')?.detail).toContain('再发一次')
})

it('leaves an ordinary reply alone', () => {
  expect(cursorProviderError('合并已经完成。')).toBeNull()
})
