import { describe, expect, it } from 'vitest'
import { POPUP_WIDTH, popupBounds } from './popup-placement'

describe('popupBounds', () => {
  it('centres the card at the top of the usable area', () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 }
    expect(popupBounds(area, 300)).toEqual({ x: (1440 - POPUP_WIDTH) / 2, y: 29, width: POPUP_WIDTH, height: 300 })
  })

  it('places it on a display that is not the first', () => {
    const bounds = popupBounds({ x: -1920, y: 0, width: 1920, height: 1040 }, 200)
    expect(bounds.x).toBe(-1920 + (1920 - POPUP_WIDTH) / 2)
  })

  it('keeps a tall card to most of the screen, and a narrow screen to its width', () => {
    expect(popupBounds({ x: 0, y: 0, width: 1000, height: 600 }, 2000).height).toBe(480)
    const narrow = popupBounds({ x: 0, y: 0, width: 400, height: 800 }, 100.4)
    expect(narrow).toEqual({ x: 0, y: 4, width: 400, height: 101 })
  })
})
