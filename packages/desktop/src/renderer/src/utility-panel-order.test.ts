import { describe, expect, it } from 'vitest'
import { openUtilityPanel, updateUtilityPanelOrder, visibleUtilityPanelOrder, type UtilityPanelsOpen } from './utility-panel-order'

const none: UtilityPanelsOpen = { browser: false, terminal: false, ports: false }

describe('utility panel order', () => {
  it('puts a newly opened panel below one already open', () => {
    const browserFirst = updateUtilityPanelOrder([], 'browser', true)
    expect(updateUtilityPanelOrder(browserFirst, 'terminal', true)).toEqual(['browser', 'terminal'])

    const terminalFirst = updateUtilityPanelOrder([], 'terminal', true)
    expect(updateUtilityPanelOrder(terminalFirst, 'browser', true)).toEqual(['terminal', 'browser'])
  })

  it('moves a closed and reopened panel to the bottom', () => {
    const closed = updateUtilityPanelOrder(['browser', 'terminal'], 'browser', false)
    expect(updateUtilityPanelOrder(closed, 'browser', true)).toEqual(['terminal', 'browser'])
  })

  it('repairs a missing order while respecting the panels that are visible', () => {
    expect(visibleUtilityPanelOrder([], { ...none, browser: true })).toEqual(['browser'])
    expect(visibleUtilityPanelOrder(['terminal'], { ...none, browser: true, terminal: true })).toEqual(['terminal', 'browser'])
    expect(visibleUtilityPanelOrder(['browser', 'terminal'], { ...none, terminal: true })).toEqual(['terminal'])
  })
})

describe('openUtilityPanel', () => {
  it('stacks any two of the three, the newer below', () => {
    expect(openUtilityPanel(['ports'], { ...none, ports: true }, 'terminal')).toEqual(['ports', 'terminal'])
    expect(openUtilityPanel(['browser'], { ...none, browser: true }, 'ports')).toEqual(['browser', 'ports'])
  })

  it('puts the top one away when a third opens', () => {
    const open = { ...none, browser: true, terminal: true }
    expect(openUtilityPanel(['browser', 'terminal'], open, 'ports')).toEqual(['terminal', 'ports'])
    expect(openUtilityPanel(['terminal', 'browser'], open, 'ports')).toEqual(['browser', 'ports'])
  })

  it('leaves a panel already open where it is', () => {
    expect(openUtilityPanel(['browser', 'terminal'], { ...none, browser: true, terminal: true }, 'browser')).toEqual(['browser', 'terminal'])
  })
})
