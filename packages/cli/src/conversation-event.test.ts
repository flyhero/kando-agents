import { describe, expect, it } from 'vitest'
import { parseCodexNotify } from './codex-notify'
import { parseConversationEvent } from './conversation-event'

describe('provider conversation events', () => {
  it('captures Codex turn identity, user input and final answer', () => {
    expect(parseConversationEvent('codex', {
      type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1',
      'input-messages': ['Do this', 'Then that'], 'last-assistant-message': 'Done'
    })).toEqual({ providerSessionId: 'thread-1', messages: [
      { role: 'user', text: 'Do this', eventKey: 'turn-1:user:0', complete: true },
      { role: 'user', text: 'Then that', eventKey: 'turn-1:user:1', complete: true },
      { role: 'assistant', text: 'Done', eventKey: 'turn-1:assistant', complete: true }
    ] })
  })

  it('captures submitted Claude prompts before completion and completed replies separately', () => {
    const prompt = parseConversationEvent('claude', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'Question' })
    const answer = parseConversationEvent('claude', { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Answer' })
    expect(prompt).toMatchObject({ providerSessionId: 's1', messages: [{ role: 'user', complete: false, text: 'Question' }] })
    expect(answer).toMatchObject({ messages: [{ role: 'assistant', complete: true, text: 'Answer' }] })
    expect(parseConversationEvent('claude', { hook_event_name: 'StopFailure', session_id: 's1', error: 'rate_limit' }).messages).toEqual([])
  })

  it('reads an existing root notify argv without changing user config', () => {
    expect(parseCodexNotify("# test\r\nnotify = [\r\n  'node', # executable\r\n  \"script with space.js\",\r\n]\r\n[features]\nfoo = true"))
      .toEqual(['node', 'script with space.js'])
    expect(parseCodexNotify('[features]\nnotify = ["not-root"]')).toBeNull()
  })
})
