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

  it('ignores events that say nothing about the user', () => {
    expect(parseTaskEvent('claude', { hook_event_name: 'PreToolUse' })).toBeNull()
    expect(parseTaskEvent('codex', { type: 'something-else' })).toBeNull()
    expect(parseTaskEvent('claude', 'not an object')).toBeNull()
  })
})
