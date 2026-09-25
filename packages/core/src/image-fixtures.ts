// Tiny images built byte by byte for tests. Only the parts core reads are real: signatures,
// headers, chunk and segment framing. Nothing here would decode to a picture.

const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff]
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
const text = (value: string) => [...Buffer.from(value, 'latin1')]

function pngChunk(type: string, data: readonly number[]): number[] {
  return [...be32(data.length), ...text(type), ...data, 0, 0, 0, 0]
}

export function pngBytes(width: number, height: number, extra: readonly { type: string; data: string }[] = []): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...extra.flatMap((chunk) => pngChunk(chunk.type, text(chunk.data))),
    ...pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00]),
    ...pngChunk('IEND', [])
  ])
}

function jpegSegment(marker: number, data: readonly number[]): number[] {
  return [0xff, marker, ...be16(data.length + 2), ...data]
}

export function jpegBytes(width: number, height: number, options: { exif?: string } = {}): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...jpegSegment(0xe0, text('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000')),
    ...(options.exif ? jpegSegment(0xe1, text(`Exif\u0000\u0000${options.exif}`)) : []),
    ...jpegSegment(0xc0, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...jpegSegment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    0x12, 0x34, 0x56,
    0xff, 0xd9
  ])
}

export function gifBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([...text('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0, 0x3b])
}

export function webpBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)])
}
