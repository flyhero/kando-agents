import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@kando/protocol'
import { ChatToolCard, ChatToolRun } from './ChatToolCard'

const opened = vi.hoisted(() => new Set<string>())
vi.mock('../chat-disclosure', () => ({ useDisclosure: (key: string) => [opened.has(key), () => {}] }))
vi.mock('../core-store', () => ({ showTerminal: vi.fn() }))
beforeEach(() => opened.clear())

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const tool = (id: string, changes: Partial<ToolItem> = {}): ToolItem => ({
  id, kind: 'tool', stageId: 'stage', revision: 1, at: 0, name: 'commandExecution', title: 'rg missing .',
  input: null, output: null, status: 'failed', diffs: [], execution: { status: 'completed', exitCode: 1 }, ...changes
})
const run = (tools: ToolItem[]) => renderToStaticMarkup(createElement(ChatToolRun, { tools }))

describe('command cards', () => {
  it.each([[19, 1], [21, 3]])('keeps the collapsed %i-command group quiet with %i nonzero exits', (count, exits) => {
    const tools = Array.from({ length: count }, (_, index) => tool(String(index), index < exits ? {} : {
      status: 'done', execution: { status: 'completed', exitCode: 0 }
    }))
    const html = run(tools)
    expect(html).toContain(`运行 ${count} 个命令`)
    expect(html).not.toContain('异常')
    expect(html).not.toContain('失败')
    expect(html).not.toContain('data-status="failed"')
    opened.add('run:stage/0')
    expect(run(tools)).not.toContain('exit 1')
    opened.add('call:stage/0')
    expect(run(tools)).toContain('exit 1')
  })

  it('lets a command with only an exit result open, keeping it out of the row status', () => {
    const command = tool('empty')
    const collapsed = run([command])
    expect(collapsed).not.toContain('disabled')
    expect(collapsed).not.toContain('exit 1')
    expect(collapsed).not.toContain('失败')
    opened.add('call:stage/empty')
    expect(run([command])).toContain('aria-label="退出码 1"')
    opened.add('card:stage/empty')
    expect(renderToStaticMarkup(createElement(ChatToolCard, { item: command }))).toContain('exit 1')
  })

  it('shows a test failure output and its exit code without calling it a success', () => {
    opened.add('call:stage/test')
    const html = run([tool('test', { title: 'pnpm test', input: 'pnpm test', output: '1 test failed' })])
    expect(html).toContain('pnpm test')
    expect(html).toContain('1 test failed')
    expect(html).toContain('exit 1')
    expect(html).not.toContain('成功')
  })

  it('keeps actual exceptions, refusals and interruptions visible while the group runs', () => {
    const html = run([
      tool('normal'), tool('running', { status: 'running', execution: undefined }),
      tool('unknown', { name: 'Bash', execution: undefined }),
      tool('failure', { execution: { status: 'failed', exitCode: 2 } }),
      tool('denied', { status: 'denied' }), tool('interrupted', { status: 'interrupted' })
    ])
    expect(html).toContain('aria-label="进行中"')
    expect(html).toContain('2 项异常')
    expect(html).toContain('1 项已拒绝')
    expect(html).toContain('1 项已中断')
  })

  it.each([0, null])('does not invent a nonzero badge for exit %s', (exitCode) => {
    opened.add('call:stage/known')
    expect(run([tool('known', { execution: { status: 'completed', exitCode } })])).not.toContain('exit ')
  })

  it('retains failure presentation from an older core', () => {
    const html = run([tool('old', { execution: undefined }), tool('new')])
    expect(html).toContain('1 项异常')
    opened.add('run:stage/old')
    expect(run([tool('old', { execution: undefined }), tool('new')])).toContain('失败')
  })
})
