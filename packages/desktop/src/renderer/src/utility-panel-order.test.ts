import { describe, expect, it } from 'vitest'
import { updateUtilityPanelOrder, visibleUtilityPanelOrder } from './utility-panel-order'

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
    expect(visibleUtilityPanelOrder([], true, false)).toEqual(['browser'])
    expect(visibleUtilityPanelOrder(['terminal'], true, true)).toEqual(['terminal', 'browser'])
    expect(visibleUtilityPanelOrder(['browser', 'terminal'], false, true)).toEqual(['terminal'])
  })
})
