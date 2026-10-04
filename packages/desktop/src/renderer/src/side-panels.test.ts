import { describe, expect, it } from 'vitest'
import { exclusivePanels, type SidePanels } from './side-panels'

const closed: SidePanels = { terminalPanelOpen: false, inspectorOpen: false, conversationInspectorOpen: false, utilityPanelOrder: [] }

describe('exclusivePanels', () => {
  it('puts the inspectors away when the terminal opens', () => {
    const before = { ...closed, inspectorOpen: true, conversationInspectorOpen: true }
    expect(exclusivePanels({ ...before, terminalPanelOpen: true, utilityPanelOrder: ['terminal'] }, before)).toEqual({ inspectorOpen: false, conversationInspectorOpen: false })
  })

  it('puts the terminal away when either inspector opens, and leaves the browser be', () => {
    const before: SidePanels = { ...closed, terminalPanelOpen: true, utilityPanelOrder: ['browser', 'terminal'] }
    const expected = { terminalPanelOpen: false, utilityPanelOrder: ['browser'] }
    expect(exclusivePanels({ ...before, inspectorOpen: true }, before)).toEqual(expected)
    expect(exclusivePanels({ ...before, conversationInspectorOpen: true }, before)).toEqual(expected)
  })

  it('changes nothing when nothing opens, or the other side is already away', () => {
    const terminal = { ...closed, terminalPanelOpen: true }
    expect(exclusivePanels(terminal, terminal)).toBeNull()
    expect(exclusivePanels(terminal, closed)).toBeNull()
    expect(exclusivePanels({ ...closed, inspectorOpen: true }, closed)).toBeNull()
    expect(exclusivePanels(closed, { ...closed, inspectorOpen: true })).toBeNull()
  })
})
