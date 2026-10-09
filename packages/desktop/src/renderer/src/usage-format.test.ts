import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@kando/protocol'
import { windowLabel } from './usage-format'

const window = (kind: UsageWindow['kind'], model: string | null = null): UsageWindow => ({ kind, model, usedPercent: 9, windowMinutes: 1, resetsAt: null })

describe('windowLabel', () => {
  it('names each window by its period, and a model-specific one by its model too', () => {
    expect([window('session'), window('weekly'), window('weekly', 'Opus'), window('monthly'), window('monthly', 'API')].map(windowLabel)).toEqual(['5h', '本周', 'Opus 本周', '本月', 'API 本月'])
  })
})
