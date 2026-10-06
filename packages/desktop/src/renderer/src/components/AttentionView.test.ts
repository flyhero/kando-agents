import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation, Task } from '@kando/protocol'
import { useCore } from '../core-store'
import { AttentionEntry } from './AttentionEntry'
import { AttentionView } from './AttentionView'

// Use the live store for markup checks rather than Zustand's fixed SSR hydration snapshot.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
beforeEach(() => useCore.setState(useCore.getInitialState(), true))
const render = () => renderToStaticMarkup(createElement(AttentionView))

describe('attention page', () => {
  it('shows the empty message only after a successful connected snapshot', () => {
    expect(render()).not.toContain('暂时没有需要你处理的事项')
    expect(render()).toContain('尚未连接到 core')
    useCore.setState({ connection: 'connected', attentionSummaryMode: 'complete' })
    expect(render()).toContain('正在读取待处理事项')
    expect(render()).not.toContain('暂时没有需要你处理的事项')
    useCore.setState({ attentionSummaryLoading: false })
    expect(render()).toContain('暂时没有需要你处理的事项')
    useCore.setState({ attentionSummaryError: 'snapshot failed' })
    expect(render()).toContain('聊天摘要加载失败')
    expect(render()).toContain('重试')
    expect(render()).not.toContain('暂时没有需要你处理的事项')
  })

  it('shows limited-core and disconnection notices without hiding known items', () => {
    const task = Task.parse({ id: 'review', title: '验收登录修复', details: '', status: 'review', repos: [], dependsOn: [], agent: 'claude', createdAt: 0, updatedAt: 0 })
    useCore.setState({ tasks: { review: task }, attentionSummaryMode: 'limited', attentionSummaryLoading: false })
    expect(render()).toContain('当前 core 的任务聊天详情不完整')
    expect(render()).toContain('以下为最近收到的信息')
    expect(render()).toContain('验收登录修复')
    expect(render()).toContain('查看任务')
  })

  it('offers allow and deny for a plain approval, and only the chat for a plan', () => {
    const waiting = (request: object) => Conversation.parse({
      id: '7d3f0a52-8c2e-4b7a-9a51-2f1c6e3b9d40', title: '提交修复', titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths: [],
      managedWorkspace: false, sessionId: 's', createdAt: 0, updatedAt: 0, chat: { turn: 'awaiting', request }
    })
    const bash = { requestId: 'r1', kind: 'approval', tool: 'Bash', title: 'git commit -m fix', decisions: ['allow', 'deny'], open: 2 }
    useCore.setState({ connection: 'connected', attentionSummaryMode: 'complete', attentionSummaryLoading: false, conversations: { c: waiting(bash) } })
    const plain = render()
    expect(plain).toContain('git commit -m fix')
    expect(plain).toContain('还有 1 项')
    expect(plain).toContain('允许一次：git commit -m fix')
    expect(plain).toContain('拒绝：git commit -m fix')
    useCore.setState({ conversations: { c: waiting({ ...bash, tool: 'ExitPlanMode', title: '计划', open: 1 }) } })
    expect(render()).not.toContain('允许一次')
    expect(render()).toContain('去处理')
  })

  it('keeps the sidebar entry at zero and counts the same subjects as the page', () => {
    const empty = renderToStaticMarkup(createElement(AttentionEntry))
    expect(empty).toContain('需要我处理')
    expect(empty).not.toContain('inbox-entry-count')
    const task = Task.parse({ id: 'reply', title: '继续规划', details: '', status: 'running', repos: [], dependsOn: [], agent: 'codex', createdAt: 0, updatedAt: 0, awaitingInput: true })
    useCore.setState({ tasks: { reply: task } })
    expect(renderToStaticMarkup(createElement(AttentionEntry))).toContain('inbox-entry-count">1</span>')
    expect(render()).toContain('1 项需要处理')
    expect(render()).toContain('需要继续处理')
  })
})
