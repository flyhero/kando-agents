import { describe, expect, it } from 'vitest'
import { chatDayAndTime, messageTime } from './labels'

describe('messageTime', () => {
  const now = new Date(2026, 9, 3, 10, 30).getTime()

  it('says only the time for a message from today, however early', () => {
    expect(messageTime(new Date(2026, 9, 3, 0, 5).getTime(), now)).toBe('00:05')
    expect(messageTime(new Date(2026, 9, 3, 9, 41).getTime(), now)).toBe('09:41')
  })

  it('adds the day for one from before today, and the year for one from an earlier year', () => {
    expect(messageTime(new Date(2026, 9, 2, 23, 59).getTime(), now)).toBe('10月2日 23:59')
    expect(messageTime(new Date(2026, 0, 15, 8, 0).getTime(), now)).toBe('1月15日 08:00')
    expect(messageTime(new Date(2025, 11, 31, 18, 20).getTime(), now)).toBe('2025年12月31日 18:20')
  })
})

describe('chatDayAndTime', () => {
  const now = new Date(2026, 9, 3, 10, 30).getTime()

  it('always says the day, and the year only for an earlier one', () => {
    expect(chatDayAndTime(new Date(2026, 9, 3, 9, 41).getTime(), now)).toBe('10月3日 09:41')
    expect(chatDayAndTime(new Date(2025, 7, 29, 10, 42).getTime(), now)).toBe('2025年8月29日 10:42')
  })
})
