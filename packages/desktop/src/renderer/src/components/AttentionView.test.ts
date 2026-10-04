import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Task } from '@kando/protocol'
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
