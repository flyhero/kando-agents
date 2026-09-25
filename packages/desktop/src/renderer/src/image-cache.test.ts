import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'
import { ImageCache } from './image-cache'

describe('ImageCache', () => {
  it('loads an image once for everyone showing it, and keeps it a while after', async () => {
    const loads: string[] = []
    const revoked: string[] = []
    const cache = new ImageCache(
      async (id) => {
        loads.push(id)
        return `blob:${id}`
      },
      (url) => revoked.push(url),
      1
    )
    const a = cache.acquire('a')
    const again = cache.acquire('a')
    expect(await a.url).toBe('blob:a')
    expect(await again.url).toBe('blob:a')
    expect(loads).toEqual(['a'])

    a.release()
    again.release()
    cache.acquire('b').release()
    await Promise.resolve()
    // Only one idle URL is kept: the older one goes.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revoked).toEqual(['blob:a'])
    expect(cache.size).toBe(1)
  })

  it('forgets a failed load so the next viewer tries again', async () => {
    let attempts = 0
    const cache = new ImageCache(
      async () => {
        attempts += 1
        throw new Error('offline')
      },
      () => {}
    )
    const first = cache.acquire('a')
    expect(await first.url).toBeNull()
    first.release()
    expect(await cache.acquire('a').url).toBeNull()
    expect(attempts).toBe(2)
  })
})

describe('base64', () => {
  it('round-trips bytes larger than one slice', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251)
    // A slow, obviously correct reference: one character at a time.
    expect(bytesToBase64(bytes)).toBe(btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')))
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })
})
