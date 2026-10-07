import { describe, expect, it } from 'vitest'
import { startModes } from './components/ChatOptionsBar'

const model = (autoMode?: boolean) => ({ id: 'opus', label: 'Opus', description: null, efforts: [], isDefault: true, ...(autoMode === undefined ? {} : { autoMode }) })

describe('startModes', () => {
  it('offers auto where the model takes it, and bypass where the settings allow it', () => {
    expect(startModes('claude', model(true), false)).toEqual(['ask', 'acceptEdits', 'plan', 'auto'])
    expect(startModes('claude', model(), true)).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('claude', undefined, false)).toEqual(['ask', 'acceptEdits', 'plan'])
    expect(startModes('codex', model(), false)).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly'])
  })
})
