import { describe, expect, it } from 'vitest'
import { withAlpha } from './css-color'

describe('withAlpha', () => {
  it('adds an alpha to an opaque colour', () => {
    expect(withAlpha('rgb(170, 170, 170)', 0.33)).toBe('rgba(170, 170, 170, 0.33)')
  })

  it('replaces the alpha of a translucent colour', () => {
    expect(withAlpha('rgba(1, 2, 3, 0.5)', 0.8)).toBe('rgba(1, 2, 3, 0.8)')
  })

  it('leaves anything else alone', () => {
    expect(withAlpha('light-dark(#fff, #000)', 0.5)).toBe('light-dark(#fff, #000)')
  })
})
