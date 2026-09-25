// What core accepts as an image, decided from the bytes alone: the extension and the MIME
// type a client or tracker claims are never trusted. Only the header is read; nothing is decoded.

export type ImageFormat = 'png' | 'jpg' | 'gif' | 'webp'

export const IMAGE_MIME: Record<ImageFormat, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export type ImageFacts = {
  format: ImageFormat
  width: number
  height: number
  // The bytes to keep: metadata that can carry a location or a device (EXIF, text chunks) removed.
  bytes: Uint8Array
}

export type ImageProblem = 'not-image' | 'too-many-pixels'

export class ImageError extends Error {
  constructor(
    readonly problem: ImageProblem,
    message: string
  ) {
    super(message)
    this.name = 'ImageError'
  }
}

// Far beyond any screenshot, and small enough that decoding one cannot exhaust a client.
const MAX_PIXELS = 40_000_000
const MAX_SIDE = 16_384

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// Text and EXIF chunks; everything else, including colour profiles, stays.
const PNG_METADATA = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf'])
// APP1 is EXIF and XMP, APP13 Photoshop's IPTC block, COM a free-form comment.
const JPEG_METADATA = new Set([0xe1, 0xed, 0xfe])

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((value, index) => bytes[at + index] === value)
const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length))
const uint32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] ?? 0) * 2 ** 24) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
const uint16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
const uint16le = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
const uint24le = (bytes: Uint8Array, at: number) => uint16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16)

const unreadable = (what: string) => new ImageError('not-image', `not a readable ${what}`)

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function png(bytes: Uint8Array): ImageFacts {
  if (ascii(bytes, 12, 4) !== 'IHDR') {
    throw unreadable('PNG')
  }
  const width = uint32(bytes, 16)
  const height = uint32(bytes, 20)
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]
  let at = 8
  let ended = false
  while (at + 12 <= bytes.byteLength) {
    const length = uint32(bytes, at)
    const type = ascii(bytes, at + 4, 4)
    const end = at + 12 + length
    if (end > bytes.byteLength) {
      throw unreadable('PNG')
    }
    if (!PNG_METADATA.has(type)) {
      kept.push(bytes.subarray(at, end))
    }
    at = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }
  if (!ended) {
    throw unreadable('PNG')
  }
  return { format: 'png', width, height, bytes: concat(kept) }
}

// Start-of-frame markers carry the size; the others (DHT C4, JPG C8, DAC CC) share the range.
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)

function jpeg(bytes: Uint8Array): ImageFacts {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)]
  let at = 2
  let width = 0
  let height = 0
  while (at + 4 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) {
      throw unreadable('JPEG')
    }
    const marker = bytes[at + 1] ?? 0
    // A fill byte before a marker; the marker itself comes next.
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Markers without a length (RSTn, TEM) carry no segment.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(bytes.subarray(at, at + 2))
      at += 2
      continue
    }
    const end = at + 2 + uint16(bytes, at + 2)
    if (end > bytes.byteLength) {
      throw unreadable('JPEG')
    }
    if (isStartOfFrame(marker)) {
      height = uint16(bytes, at + 5)
      width = uint16(bytes, at + 7)
    }
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data runs to the end; keep it as it is.
      kept.push(bytes.subarray(at))
      break
    }
    if (!JPEG_METADATA.has(marker)) {
      kept.push(bytes.subarray(at, end))
    }
    at = end
  }
  if (width === 0 || height === 0) {
    throw unreadable('JPEG')
  }
  return { format: 'jpg', width, height, bytes: concat(kept) }
}

function gif(bytes: Uint8Array): ImageFacts {
  return { format: 'gif', width: uint16le(bytes, 6), height: uint16le(bytes, 8), bytes }
}

function webp(bytes: Uint8Array): ImageFacts {
  const chunk = ascii(bytes, 12, 4)
  const data = 20
  if (chunk === 'VP8 ' && startsWith(bytes, [0x9d, 0x01, 0x2a], data + 3)) {
    return { format: 'webp', width: uint16le(bytes, data + 6) & 0x3fff, height: uint16le(bytes, data + 8) & 0x3fff, bytes }
  }
  if (chunk === 'VP8L' && bytes[data] === 0x2f) {
    const b1 = bytes[data + 1] ?? 0
    const b2 = bytes[data + 2] ?? 0
    const b3 = bytes[data + 3] ?? 0
    const b4 = bytes[data + 4] ?? 0
    return {
      format: 'webp',
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      bytes
    }
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: 1 + uint24le(bytes, data + 4), height: 1 + uint24le(bytes, data + 7), bytes }
  }
  throw unreadable('WebP')
}

export function inspectImage(bytes: Uint8Array): ImageFacts {
  let facts: ImageFacts
  if (startsWith(bytes, PNG_SIGNATURE)) {
    facts = png(bytes)
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    facts = jpeg(bytes)
  } else if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    facts = gif(bytes)
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    facts = webp(bytes)
  } else {
    throw new ImageError('not-image', 'only PNG, JPEG, GIF and WebP images are accepted')
  }
  if (facts.width < 1 || facts.height < 1) {
    throw unreadable(facts.format)
  }
  if (facts.width > MAX_SIDE || facts.height > MAX_SIDE || facts.width * facts.height > MAX_PIXELS) {
    throw new ImageError('too-many-pixels', `${facts.width}×${facts.height} is larger than an image may be`)
  }
  return facts
}
