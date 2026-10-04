import { describe, expect, it } from 'vitest'
import { isValidSchedule } from '@kando/protocol'
import { ROUTINE_TEMPLATES } from './routine-templates'
import { scheduleText } from './routines'

describe('ROUTINE_TEMPLATES', () => {
  it('each names a time the scheduler can keep, says what to do, and tells the agent not to change things unasked', () => {
    expect(new Set(ROUTINE_TEMPLATES.map((template) => template.id)).size).toBe(ROUTINE_TEMPLATES.length)
    for (const template of ROUTINE_TEMPLATES) {
      expect(isValidSchedule(template.schedule)).toBe(true)
      expect(scheduleText(template.schedule)).not.toBe('手动')
      expect(template.text.length).toBeGreaterThan(40)
      expect(template.text).toMatch(/不要|只读/)
      expect(template.title.length).toBeLessThanOrEqual(12)
    }
  })
})
