import { describe, expect, it } from 'vitest'

describe('jpegSize', () => {
  it('reads the frame size out of the start-of-frame marker', async () => {
    const { jpegSize } = await import('./screencast')
    // SOI, an APP0 segment of 16 bytes, then a baseline SOF0 declaring 640×400.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03]), Buffer.alloc(9)
    ])
    expect(jpegSize(jpeg)).toEqual({ width: 640, height: 400 })
    expect(jpegSize(Buffer.from([0x89, 0x50]))).toBeNull()
  })
})
