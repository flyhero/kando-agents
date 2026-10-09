import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeBrowserPage, type ChatItem } from '@kando/protocol'
import { ChatBrowserCard, ChatBrowserRun } from './ChatBrowserCard'

const opened = vi.hoisted(() => new Set<string>())
vi.mock('../chat-disclosure', () => ({ useDisclosure: (key: string) => [opened.has(key), () => {}] }))
vi.mock('../core-store', () => ({
  useCore: () => false, showBrowserTab: vi.fn(), showTerminal: vi.fn()
}))
vi.mock('../browser-state', () => ({ useBrowserTabs: () => null, ALL_TABS: 'all' }))
vi.mock('../attachment-images', () => ({ useImageUrl: () => 'data:image/png;base64,test' }))
vi.mock('./ChatMarkdown', () => ({ LocalImageViewer: () => null }))
vi.mock('./ImageViewer', () => ({ ImageViewer: () => null }))
beforeEach(() => opened.clear())

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const tabId = '10dbacd0-d598-495a-997a-498a87d1e70e'
const call = (id: string, changes: Partial<ToolItem> = {}): ToolItem => ({
  id, kind: 'tool', stageId: 'stage', revision: 1, at: 0, name: 'kando.browser_navigate',
  title: id, input: id, status: 'done', diffs: [],
  output: describeBrowserPage({ id: tabId, title: `Page ${id}`, url: `http://localhost/preview?version=${id}` }, `${id} snapshot`), ...changes
})
const render = (tools: ToolItem[]) => renderToStaticMarkup(createElement(ChatBrowserRun, { tools }))

describe('browser work', () => {
  it('renders a collapsed history and just one latest page for a repeated tab', () => {
    const html = render([call('first'), call('refresh'), call('click', { name: 'kando.browser_click' })])
    expect(html).toContain('浏览器操作 3 次')
    expect(html.match(/class="chat-tool chat-page"/g)).toHaveLength(1)
    expect(html).toContain('Page click')
    expect(html).toContain('preview?version=click')
    expect(html).not.toContain('Page first')
    expect(html).not.toContain('first snapshot')
    expect(html).toContain('aria-expanded="false"')
  })

  it('lets even a single browser operation expand into history', () => {
    expect(render([call('first')])).toContain('浏览器操作 1 次')
    opened.add('run:stage/first')
    opened.add('call:stage/first')
    expect(render([call('first')])).toContain('first snapshot')
  })

  it('retains every historical result without adding page cards when history opens', () => {
    opened.add('run:stage/first')
    opened.add('call:stage/first')
    opened.add('call:stage/refresh')
    const html = render([call('first'), call('refresh')])
    expect(html).toContain('first snapshot')
    expect(html).toContain('refresh snapshot')
    expect(html.match(/class="chat-tool chat-page"/g)).toHaveLength(1)
  })

  it('keeps the page disclosure attached to the tab when its latest result changes', () => {
    opened.add(`card:browser:stage/first:${tabId}`)
    expect(render([call('first')])).toContain('first snapshot')
    const html = render([call('first'), call('refresh')])
    expect(html).toContain('refresh snapshot')
    expect(html).not.toContain('first snapshot')
    expect(html).toContain('收起快照')
  })

  it('shows separate entry points for different tabs', () => {
    const other = call('other', { output: describeBrowserPage({
      id: '20dbacd0-d598-495a-997a-498a87d1e70e', title: 'Other tab', url: 'http://localhost/'
    }, null) })
    const html = render([call('first'), other, call('refresh')])
    expect(html.match(/class="chat-tool chat-page"/g)).toHaveLength(2)
    expect(html).toContain('Other tab')
    expect(html).toContain('Page refresh')
  })

  it('keeps failures and refusals visible without replacing the successful page', () => {
    const html = render([call('first'), call('bad', { status: 'failed', output: 'Navigation failed' }),
      call('denied', { status: 'denied', output: '用户拒绝了访问' })])
    expect(html).toContain('1 项异常')
    expect(html).toContain('1 项已拒绝')
    expect(html).toContain('Page first')
    expect(html.match(/class="chat-tool chat-page"/g)).toHaveLength(1)
  })

  it('does not invent an entry point while waiting for permission or the first response', () => {
    const html = render([call('waiting', { status: 'running', output: null })])
    expect(html).toContain('浏览器操作 1 次')
    expect(html).toContain('aria-label="进行中"')
    expect(html).not.toContain('chat-page-row')
    expect(render([call('gate', { output: '等待用户确认' })])).not.toContain('chat-page-row')
  })

  it('keeps screenshot images as independent cards, including images returned by navigation', () => {
    for (const name of ['kando.browser_screenshot', 'kando.browser_navigate']) {
      const html = renderToStaticMarkup(createElement(ChatBrowserCard, { item: call('shot', {
        name, images: [{ id: `${'a'.repeat(64)}.png`, width: 2, height: 1 }]
      }) }))
      expect(html).toContain('aria-label="查看截图"')
      expect(html).toContain('<img')
    }
  })
})
