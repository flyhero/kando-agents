import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { endList } from './markdown-live-preview'

// Enter at the end of the text, as the user would press it; null when endList leaves it to the default.
function enterAtEnd(doc: string): string | null {
  let state = EditorState.create({ doc, selection: { anchor: doc.length } })
  const view = { get state() { return state }, dispatch: (spec: TransactionSpec) => { state = state.update(spec).state } }
  return endList(view) ? state.doc.toString() : null
}

describe('ending a list on Enter', () => {
  it('ends the list on its empty last item with a blank line, for a paragraph of its own', () => {
    expect(enterAtEnd('- one\n- ')).toBe('- one\n\n')
    expect(enterAtEnd('- [ ] one\n- [ ] ')).toBe('- [ ] one\n\n')
    expect(enterAtEnd('1. one\n2. ')).toBe('1. one\n\n')
  })

  it('leaves the rest to the default: an item with text, a nested one, or the first line', () => {
    expect(enterAtEnd('- one')).toBeNull()
    expect(enterAtEnd('- one\n  - ')).toBeNull()
    expect(enterAtEnd('- ')).toBeNull()
  })
})
