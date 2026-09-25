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

  it('drops the title turn Codex runs in its own thread, thread id included', () => {
    const prompt = 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. ' +
      'Start with an imperative verb. Do not answer the request.\n\nUser prompt:\n评价本项目'
    expect(parseConversationEvent('codex', {
      type: 'agent-turn-complete', 'thread-id': 'title-thread', 'turn-id': 'turn-2',
      'input-messages': [prompt], 'last-assistant-message': '{"title":"评估项目"}'
    })).toEqual({ providerSessionId: null, messages: [] })
    expect(parseConversationEvent('codex', {
      type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-3',
      'input-messages': ['Generate a concise title for this PR'], 'last-assistant-message': 'Fix login'
    }).messages).toHaveLength(2)
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
