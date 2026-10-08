import { expect, it } from 'vitest'
import { ChatItem } from '@kando/protocol'
import { copyTextForItem } from './message-copy'

const base = { id: 'item', stageId: 'stage', revision: 1, at: 0 }

it('copies assistant Markdown source and preserves whitespace', () => {
  const text = '## Title\n\n```ts\n  const a = 1\n```\n'
  expect(copyTextForItem(ChatItem.parse({ ...base, kind: 'assistant', text, streaming: false }))).toBe(text)
})

it('copies full tool output, input and patches without interface labels or clipping', () => {
  const output = 'a'.repeat(5000)
  const item = ChatItem.parse({ ...base, kind: 'tool', name: 'Edit', title: 'a.ts', input: '{}', output, status: 'done', diffs: [{ path: 'a.ts', change: 'update', patch: '+hello' }] })
  expect(copyTextForItem(item)).toBe(`a.ts\n\n{}\n\n${output}\n\na.ts\n+hello`)
})

it('copies checklist and reasoning content', () => {
  expect(copyTextForItem(ChatItem.parse({ ...base, kind: 'todos', todos: [{ content: 'done', status: 'completed', activeForm: null }] }))).toBe('[x] done')
  expect(copyTextForItem(ChatItem.parse({ ...base, kind: 'reasoning', text: 'thinking', streaming: true }))).toBe('thinking')
})
