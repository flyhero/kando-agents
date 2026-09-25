import { describe, expect, it } from 'vitest'
import { parseTaskEvent } from './task-event'

describe('parseTaskEvent', () => {
  it('reads a finished turn or a permission prompt as waiting, a new prompt as working', () => {
    expect(parseTaskEvent('claude', { hook_event_name: 'Stop' })).toBe(true)
    expect(parseTaskEvent('claude', { hook_event_name: 'StopFailure' })).toBe(true)
    expect(parseTaskEvent('claude', { hook_event_name: 'Notification', message: 'Claude needs your permission' })).toBe(true)
    expect(parseTaskEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })).toBe(false)
    expect(parseTaskEvent('codex', { type: 'agent-turn-complete', 'turn-id': 't1' })).toBe(true)
  })

  it('ignores the title turn Codex runs beside a task\'s first turn', () => {
    const prompt = 'Generate a concise, single-line task title of at most 36 characters and under five words where possible. ' +
      'Start with an imperative verb. Do not answer the request.\n\nUser prompt:\n测试任务\n\n回复 收到 就行'
    expect(parseTaskEvent('codex', {
      type: 'agent-turn-complete', 'thread-id': 'title-thread', 'turn-id': 't2',
      'input-messages': [prompt], 'last-assistant-message': '{"title":"回复收到"}'
    })).toBeNull()
    expect(parseTaskEvent('codex', {
      type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 't3',
      'input-messages': ['Generate a concise title for this PR'], 'last-assistant-message': 'Fix login'
    })).toBe(true)
  })

  it('ignores events that say nothing about the user', () => {
    expect(parseTaskEvent('claude', { hook_event_name: 'PreToolUse' })).toBeNull()
    expect(parseTaskEvent('codex', { type: 'something-else' })).toBeNull()
    expect(parseTaskEvent('claude', 'not an object')).toBeNull()
  })
})
