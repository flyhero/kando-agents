import { describe, expect, it } from 'vitest'
import { gifBytes, jpegBytes, pngBytes, webpBytes } from './image-fixtures'
import { ImageError, inspectImage } from './image-file'

const includes = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(Buffer.from(needle, 'latin1'))

describe('inspectImage', () => {
  it('reads format and size from the header of each accepted format', () => {
    expect(inspectImage(pngBytes(640, 480))).toMatchObject({ format: 'png', width: 640, height: 480 })
    expect(inspectImage(jpegBytes(1920, 1080))).toMatchObject({ format: 'jpg', width: 1920, height: 1080 })
    expect(inspectImage(gifBytes(32, 16))).toMatchObject({ format: 'gif', width: 32, height: 16 })
    expect(inspectImage(webpBytes(800, 600))).toMatchObject({ format: 'webp', width: 800, height: 600 })
  })

  it('drops text chunks and EXIF, keeping the rest byte for byte', () => {
    const png = pngBytes(10, 10, [{ type: 'tEXt', data: 'Author\u0000me' }, { type: 'eXIf', data: 'GPS 31.2N' }])
    const cleanPng = inspectImage(png).bytes
    expect(includes(cleanPng, 'GPS')).toBe(false)
    expect(Buffer.from(cleanPng)).toEqual(Buffer.from(pngBytes(10, 10)))

    const jpeg = inspectImage(jpegBytes(10, 10, { exif: 'GPS 31.2N' })).bytes
    expect(includes(jpeg, 'GPS')).toBe(false)
    expect(Buffer.from(jpeg)).toEqual(Buffer.from(jpegBytes(10, 10)))
  })

  it('refuses what is not one of the four formats, including SVG and a renamed text file', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect(() => inspectImage(svg)).toThrow(ImageError)
    expect(() => inspectImage(Buffer.from('not really a png'))).toThrow(/only PNG/)
    expect(() => inspectImage(pngBytes(10, 10).subarray(0, 30))).toThrow(/not a readable/)
  })

  it('refuses dimensions no screenshot has, before anything decodes them', () => {
    expect(() => inspectImage(pngBytes(20_000, 10))).toThrow(expect.objectContaining({ problem: 'too-many-pixels' }))
    expect(() => inspectImage(pngBytes(8_000, 8_000))).toThrow(expect.objectContaining({ problem: 'too-many-pixels' }))
    expect(() => inspectImage(pngBytes(0, 10))).toThrow(ImageError)
  })
})
