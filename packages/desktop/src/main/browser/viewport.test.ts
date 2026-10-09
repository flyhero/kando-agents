import { describe, expect, it } from 'vitest'
import { fitViewport } from './viewport'

describe('fitViewport', () => {
  const panel = { x: 100, y: 50, width: 1000, height: 700 }

  it('fills the panel while the tab follows it', () => {
    expect(fitViewport(panel, null)).toEqual(panel)
  })

  it('centres a page smaller than the panel at its own size', () => {
    expect(fitViewport(panel, { width: 390, height: 844 })).toEqual({ x: 100 + Math.round((1000 - 323) / 2), y: 50, width: 323, height: 700 })
    expect(fitViewport(panel, { width: 400, height: 300 })).toEqual({ x: 400, y: 250, width: 400, height: 300 })
  })

  it('scales a page larger than the panel down to fit, keeping its aspect', () => {
    const fitted = fitViewport(panel, { width: 1920, height: 1080 })
    expect(fitted.width).toBe(1000)
    expect(fitted.height).toBe(563)
    expect(fitted.y).toBe(50 + Math.round((700 - 563) / 2))
  })
})
