import { describe, expect, it } from 'vitest'
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, sidebarMaxWidth } from './sidebar-width'

describe('clampSidebarWidth', () => {
  it('keeps a width between the limits as it is, rounded to a whole pixel', () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1280)).toBe(320)
    expect(clampSidebarWidth(301.6, 1280)).toBe(302)
  })

  it('stops at the narrowest and the widest', () => {
    expect(clampSidebarWidth(80, 1280)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(900, 1600)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('leaves a small window most of its width for the pane', () => {
    expect(sidebarMaxWidth(900)).toBe(360)
    expect(clampSidebarWidth(480, 900)).toBe(360)
  })

  it('never goes under the narrowest, however small the window', () => {
    expect(sidebarMaxWidth(400)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(300, 400)).toBe(MIN_SIDEBAR_WIDTH)
  })
})
