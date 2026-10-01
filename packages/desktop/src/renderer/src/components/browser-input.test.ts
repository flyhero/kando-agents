import { describe, expect, it } from 'vitest'
import { frameBudget, frameFit, keyEvent, modifiersOf, mouseEvent, toTabPoint, wheelEvent } from './browser-input'

const viewport = { width: 1280, height: 800 }
const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('frameFit and toTabPoint', () => {
  it('letterboxes a wide box and maps a point back to the page', () => {
    const box = { left: 10, top: 20, width: 1000, height: 1000 }
    const fit = frameFit(box, viewport)
    expect(fit.scale).toBeCloseTo(1000 / 1280)
    expect(fit.offsetX).toBe(10)
    expect(fit.offsetY).toBeCloseTo(20 + (1000 - 625) / 2)
    expect(toTabPoint(10 + 500, fit.offsetY + 312.5, box, viewport)).toEqual({ x: 640, y: 400 })
    expect(toTabPoint(5, 500, box, viewport)).toBeNull()
    expect(toTabPoint(500, 25, box, viewport)).toBeNull()
  })
})

describe('input events', () => {
  it('builds CDP\'s modifier mask and mouse buttons', () => {
    expect(modifiersOf({ ...keys, altKey: true, shiftKey: true })).toBe(9)
    expect(mouseEvent('pressed', { ...keys, button: 2, buttons: 2, detail: 2 }, { x: 1, y: 2 })).toEqual({ type: 'mouse', action: 'pressed', x: 1, y: 2, button: 'right', buttons: 2, clickCount: 2, modifiers: 0 })
    expect(mouseEvent('moved', { ...keys, button: 0, buttons: 0, detail: 0 }, { x: 1, y: 2 })).toMatchObject({ button: 'none', clickCount: 0 })
  })

  it('scales wheel lines and pages to pixels', () => {
    expect(wheelEvent({ ...keys, deltaX: 0, deltaY: 3, deltaMode: 1 }, { x: 0, y: 0 }, viewport)).toMatchObject({ deltaY: 48 })
    expect(wheelEvent({ ...keys, deltaX: 0, deltaY: 1, deltaMode: 2 }, { x: 0, y: 0 }, viewport)).toMatchObject({ deltaY: 800 })
  })

  it('types a printable key, keeps shortcuts silent, and leaves Escape and composition alone', () => {
    expect(keyEvent('down', { ...keys, key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })).toMatchObject({ text: 'a', windowsVirtualKeyCode: 65 })
    expect(keyEvent('up', { ...keys, key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })).not.toHaveProperty('text')
    expect(keyEvent('down', { ...keys, metaKey: true, key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })).toMatchObject({ modifiers: 4 })
    expect(keyEvent('down', { ...keys, metaKey: true, key: 'a', code: 'KeyA', keyCode: 65, isComposing: false })).not.toHaveProperty('text')
    expect(keyEvent('down', { ...keys, key: 'Escape', code: 'Escape', keyCode: 27, isComposing: false })).toBeNull()
    expect(keyEvent('down', { ...keys, key: 'a', code: 'KeyA', keyCode: 229, isComposing: true })).toBeNull()
  })
})

describe('frameBudget', () => {
  it('asks for frames in steps that cover the display, never past the page', () => {
    expect(frameBudget(400, 300, 1, viewport)).toEqual({ maxWidth: 480, maxHeight: 300 })
    expect(frameBudget(400, 300, 2, viewport)).toEqual({ maxWidth: 800, maxHeight: 500 })
    expect(frameBudget(3000, 3000, 2, viewport)).toEqual({ maxWidth: 1280, maxHeight: 800 })
  })
})
