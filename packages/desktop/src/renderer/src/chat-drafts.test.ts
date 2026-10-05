import { describe, expect, it } from 'vitest'
import { offerDraft, takeDraft } from './chat-drafts'

describe('chat drafts', () => {
  it('hands a draft to its conversation once', () => {
    offerDraft('a', { text: '再想想', images: [] })
    expect(takeDraft('b')).toBeNull()
    expect(takeDraft('a')).toEqual({ text: '再想想', images: [] })
    expect(takeDraft('a')).toBeNull()
  })
})
