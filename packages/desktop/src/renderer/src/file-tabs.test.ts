import { afterEach, expect, it } from 'vitest'
import type { ResolvedFile } from '@kando/protocol'
import { closedFile, EMPTY_FILE_TABS, forgetFileTabs, openedFile, saveFileScroll, updateFileTabs, useFileTabs } from './file-tabs'

const file: ResolvedFile = { path: '/project/a.ts', root: '/project', relative: 'a.ts', kind: 'file' }
afterEach(() => useFileTabs.setState({}, true))

it('deduplicates file tabs while honoring another request to reveal a line', () => {
  const first = openedFile(EMPTY_FILE_TABS, file, 10)
  const moved = { ...first, tabs: first.tabs.map((tab) => ({ ...tab, scrollTop: 300 })) }
  const again = openedFile(moved, file, 20)
  expect(again.tabs).toHaveLength(1)
  expect(again.tabs[0]).toMatchObject({ line: 20, reveal: 2, scrollTop: 300 })
})

it('selects a neighboring tab on close and exits maximized mode on the last close', () => {
  const next = { ...file, path: '/project/b.ts', relative: 'b.ts' }
  const both = { ...openedFile(openedFile(EMPTY_FILE_TABS, file, null), next, null), maximized: true }
  const one = closedFile(both, next.path)
  expect(one.active).toBe(file.path)
  expect(one.maximized).toBe(true)
  expect(closedFile(one, file.path)).toMatchObject({ tabs: [], active: null, maximized: false })
})

it('isolates selections and scroll positions between conversations and cleans deleted ones', () => {
  for (const id of ['first', 'second']) updateFileTabs(id, (state) => openedFile(state, file, null))
  saveFileScroll('first', file.path, 100, 20)
  expect(useFileTabs.getState().first?.tabs[0]?.scrollTop).toBe(100)
  expect(useFileTabs.getState().second?.tabs[0]?.scrollTop).toBe(0)
  forgetFileTabs('first')
  expect(useFileTabs.getState().first).toBeUndefined()
  expect(useFileTabs.getState().second).toBeDefined()
})
