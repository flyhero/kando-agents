import { describe, expect, it } from 'vitest'
import { installPercent } from './chromium'

describe('installPercent', () => {
  it('reads the installer\'s progress bar', () => {
    expect(installPercent('|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 148.8 MiB')).toBe(100)
    expect(installPercent('|■■■■            | 23% of 148.8 MiB')).toBe(23)
    expect(installPercent('Downloading Chromium 141.0.7390.37 (playwright build v1194)')).toBeNull()
    expect(installPercent('something 250% off')).toBeNull()
  })
})
