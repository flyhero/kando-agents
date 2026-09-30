import { describe, expect, it } from 'vitest'
import { checkEditAdditionalProjects, checkSwitchBranch } from './conversation'

describe('checkSwitchBranch', () => {
  const conversation = { taskId: null, sessionId: null, mode: 'chat' as const, chat: null }

  it('switches while no agent works in the folder: none open, or a chat one idle', () => {
    expect(checkSwitchBranch(conversation)).toBeNull()
    expect(checkSwitchBranch({ ...conversation, mode: 'tui' })).toBeNull()
    expect(checkSwitchBranch({ ...conversation, sessionId: 's', chat: { turn: 'idle' } })).toBeNull()
  })

  it('waits for a terminal agent to stop and a chat one to finish, and leaves a task\'s branch alone', () => {
    expect(checkSwitchBranch({ ...conversation, sessionId: 's', mode: 'tui' })).toBe('conversation-running')
    expect(checkSwitchBranch({ ...conversation, sessionId: 's', chat: { turn: 'running' } })).toBe('chat-busy')
    expect(checkSwitchBranch({ ...conversation, sessionId: 's', chat: { turn: 'awaiting' } })).toBe('chat-busy')
    expect(checkSwitchBranch({ ...conversation, taskId: 't' })).toBe('task-conversation')
  })
})

describe('checkEditAdditionalProjects', () => {
  const conversation = { taskId: null, sessionId: null, mode: 'chat' as const, chat: null, managedWorkspace: false }

  it('changes them while no agent runs, or a chat one is idle and can restart on its session', () => {
    expect(checkEditAdditionalProjects(conversation)).toBeNull()
    expect(checkEditAdditionalProjects({ ...conversation, sessionId: 's', chat: { turn: 'idle' } })).toBeNull()
  })

  it('waits for a busy agent, and leaves a task\'s and a projectless conversation\'s alone', () => {
    expect(checkEditAdditionalProjects({ ...conversation, sessionId: 's', mode: 'tui' })).toBe('conversation-running')
    expect(checkEditAdditionalProjects({ ...conversation, sessionId: 's', chat: { turn: 'running' } })).toBe('chat-busy')
    expect(checkEditAdditionalProjects({ ...conversation, taskId: 't' })).toBe('task-conversation')
    expect(checkEditAdditionalProjects({ ...conversation, managedWorkspace: true })).toBe('managed-workspace')
  })
})
