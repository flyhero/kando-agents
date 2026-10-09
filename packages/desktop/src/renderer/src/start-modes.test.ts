import { describe, expect, it } from 'vitest'
import { defaultStartMode, modeLabel, startModes } from './components/ChatOptionsBar'

const model = (autoMode?: boolean) => ({ id: 'opus', label: 'Opus', description: null, efforts: [], isDefault: true, ...(autoMode === undefined ? {} : { autoMode }) })

describe('startModes', () => {
  it('shows Cursor native modes and excludes auto and bypass even when preferences allow them', () => {
    const modes = startModes('cursor', model(true), true)
    expect(modes).toEqual(['ask', 'plan', 'readOnly'])
    expect(modes.map((mode) => modeLabel('cursor', mode))).toEqual(['Agent', 'Plan', 'Ask'])
    expect(defaultStartMode('cursor', modes)).toBe('ask')
  })
  it('offers auto where the model takes it, and bypass where the settings allow it', () => {
    expect(startModes('claude', model(true), false)).toEqual(['ask', 'acceptEdits', 'plan', 'auto'])
    expect(startModes('claude', model(), true)).toEqual(['ask', 'acceptEdits', 'plan', 'bypass'])
    expect(startModes('claude', undefined, false)).toEqual(['ask', 'acceptEdits', 'plan'])
    expect(startModes('codex', model(), false)).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly'])
    expect(startModes('codex', model(true), false)).toEqual(['acceptEdits', 'ask', 'plan', 'readOnly'])
  })

  it('defaults each agent independently and falls back when Claude auto is unavailable', () => {
    expect(defaultStartMode('claude', startModes('claude', model(true), false))).toBe('auto')
    expect(defaultStartMode('claude', startModes('claude', model(), false))).toBe('ask')
    expect(defaultStartMode('codex', startModes('codex', model(), false))).toBe('acceptEdits')
  })
})
