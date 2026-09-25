import { describe, expect, it } from 'vitest'
import type { Conversation } from '@kando/protocol'
import { conversationState } from './conversation-state'

const base: Conversation = {
  id: '11111111-1111-4111-8111-111111111111', title: 't', titleLocked: false, agent: 'claude', workspacePath: '/w',
  projectPaths: [], managedWorkspace: true, sessionId: null, createdAt: 0, updatedAt: 0
}
const label = (patch: Partial<Conversation>) => conversationState({ ...base, ...patch })

describe('conversationState', () => {
  it('tells how the agent last stopped', () => {
    expect(label({ sessionId: 's', lastExit: { code: 1, at: 1 } })).toMatchObject({ label: '运行中', running: true, failed: false })
    expect(label({ lastExit: null }).label).toBe('未启动')
    expect(label({ lastExit: { code: null, at: 1 } }).label).toBe('已停止')
    expect(label({ lastExit: { code: 0, at: 1 } })).toMatchObject({ label: '已退出', failed: false })
    expect(label({ lastExit: { code: 1, at: 1 } })).toMatchObject({ label: '异常退出', failed: true, detail: 'agent 异常退出（code 1）' })
  })

  it('says only "not running" to an older core that sends no exit', () => {
    expect(label({}).label).toBe('未运行')
  })
})
