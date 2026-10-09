import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import { ChatSubagents } from './ChatSubagents'

vi.mock('../chat-disclosure', () => ({ useDisclosure: () => [false, () => {}] }))
vi.mock('./ChatMarkdown', () => ({ ChatMarkdown: () => null }))

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const subagent = (metrics: ToolItem['metrics']): ToolItem => ({
  id: 'tool:task', stageId: 'stage', revision: 1, at: 0, kind: 'tool', name: 'Task', title: 'Settings UI',
  input: '{"prompt":"Read the settings code"}', status: 'done', output: null, diffs: [], metrics
})
const render = (metrics: ToolItem['metrics']) => renderToStaticMarkup(createElement(ChatSubagents, { tools: [subagent(metrics)] }))

describe('subagent card', () => {
  it('shows the time when the agent reports nothing else about the subagent', () => {
    expect(render({ tools: 0, tokens: 0, durationMs: 584_426 })).toContain('用了 10 分钟')
  })
  it('keeps the time out of sight when the subagent reported its tools and tokens', () => {
    const html = render({ tools: 12, tokens: 0, durationMs: 584_426 })
    expect(html).toContain('12 工具')
    expect(html).not.toContain('用了 10 分钟')
  })
})
