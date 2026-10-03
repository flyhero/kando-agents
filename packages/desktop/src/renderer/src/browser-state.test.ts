import { describe, expect, it } from 'vitest'
import type { BrowserTab } from '@kando/protocol'
import { ALL_TABS, fileUrl, firstBrowserCall, receiveAllBrowserTabs, receiveBrowserTabs, selectAfter, useBrowserTabs, USER_TABS } from './browser-state'

const tab = (id: string, active = false): BrowserTab => ({ id, conversationId: 'c', url: 'http://localhost/', title: '', loading: false, active, userDriving: false, agentActing: false, createdAt: 1 })

describe('selectAfter', () => {
  it('keeps the selection while its tab is open, else follows the agent, else the newest', () => {
    expect(selectAfter(undefined, [tab('a'), tab('b', true)]).selectedId).toBe('b')
    expect(selectAfter({ tabs: [], selectedId: 'a' }, [tab('a'), tab('b', true)]).selectedId).toBe('a')
    expect(selectAfter({ tabs: [], selectedId: 'gone' }, [tab('a'), tab('b')]).selectedId).toBe('b')
    expect(selectAfter({ tabs: [], selectedId: 'a' }, []).selectedId).toBeNull()
  })
})

describe('the scope of every tab', () => {
  it('keeps the user\'s own tabs and each conversation\'s apart, and all of them together', () => {
    useBrowserTabs.setState({}, true)
    receiveAllBrowserTabs([{ ...tab('a'), conversationId: 'c1' }, { ...tab('u'), conversationId: null }])
    expect(useBrowserTabs.getState()['c1']?.tabs.map((each) => each.id)).toEqual(['a'])
    expect(useBrowserTabs.getState()[USER_TABS]?.tabs.map((each) => each.id)).toEqual(['u'])
    expect(useBrowserTabs.getState()[ALL_TABS]?.tabs.map((each) => each.id)).toEqual(['a', 'u'])
    receiveBrowserTabs('c1', [])
    expect(useBrowserTabs.getState()[ALL_TABS]?.tabs.map((each) => each.id)).toEqual(['u'])
    expect(useBrowserTabs.getState()[ALL_TABS]?.selectedId).toBe('u')
  })
})

describe('firstBrowserCall', () => {
  it('names the first browser call still running, and nothing for finished history', () => {
    expect(firstBrowserCall([{ kind: 'tool', name: 'mcp__kando__browser_navigate', status: 'done', stageId: 's', id: 't:1' }])).toBeNull()
    expect(firstBrowserCall([{ kind: 'tool', name: 'Bash', status: 'running', stageId: 's', id: 't:1' }, { kind: 'tool', name: 'kando.browser_click', status: 'running', stageId: 's', id: 't:2' }])).toBe('s/t:2')
  })
})

describe('fileUrl', () => {
  it('names a local file the way the browser opens it, keeping a # or a space part of the name', () => {
    expect(fileUrl('/tmp/demo/index.html')).toBe('file:///tmp/demo/index.html')
    expect(fileUrl('/Users/me/My Site/#1.html')).toBe('file:///Users/me/My%20Site/%231.html')
  })
})
