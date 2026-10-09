import { describe, expect, it } from 'vitest'
import { describeBrowserPage, type ChatItem } from '@kando/protocol'
import { latestBrowserPages } from './chat-browser'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const tabId = '10dbacd0-d598-495a-997a-498a87d1e70e'
const page = (url: string, id = tabId) => ({ id, title: url, url })
const call = (id: string, url: string, changes: Partial<ToolItem> = {}): ToolItem => ({
  id, stageId: 'stage', revision: 1, at: 0, kind: 'tool', name: 'kando.browser_navigate',
  title: url, input: null, output: describeBrowserPage(page(url), 'snapshot'), status: 'done', diffs: [], ...changes
})

describe('latestBrowserPages', () => {
  it('shows only the latest successful page for a tab, even across different URLs and refreshes', () => {
    const tools = [call('a', 'http://localhost/preview?model=auto'), call('b', 'http://localhost/preview?model=sonnet'),
      call('c', 'http://localhost/other'), call('d', 'http://localhost/other')]
    expect(latestBrowserPages(tools)).toEqual([{ item: tools[3], page: page('http://localhost/other') }])
    expect(tools).toHaveLength(4)
  })

  it('uses snapshots and interactions to update a page reached without an explicit navigation', () => {
    const tools = [call('a', 'http://localhost/', { name: 'kando.browser_tabs' }),
      call('b', 'http://localhost/next', { name: 'mcp__kando__browser_click' }),
      call('c', 'http://localhost/final', { name: 'kando.browser_snapshot' })]
    expect(latestBrowserPages(tools)).toEqual([{ item: tools[2], page: page('http://localhost/final') }])
  })

  it('keeps different tabs separate even when their URLs match', () => {
    const other = page('http://localhost/', '20dbacd0-d598-495a-997a-498a87d1e70e')
    const tools = [call('a', other.url), call('b', other.url, { output: describeBrowserPage(other, null) })]
    expect(latestBrowserPages(tools).map((result) => result.page.id)).toEqual([tabId, other.id])
  })

  it.each(['running', 'failed', 'denied', 'interrupted'] as const)('does not replace a successful page with a %s result', (status) => {
    const good = call('good', 'http://localhost/')
    expect(latestBrowserPages([good, call('bad', 'http://localhost/bad', { status })]))
      .toEqual([{ item: good, page: page('http://localhost/') }])
  })

  it('does not invent pages from refusals, missing outputs or unrelated tool results', () => {
    expect(latestBrowserPages([
      call('gate', '', { output: '等待用户确认' }), call('empty', '', { output: null }),
      call('cmd', 'http://localhost/', { name: 'Bash' })
    ])).toEqual([])
  })
})
