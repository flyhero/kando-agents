import { afterEach, expect, it, vi } from 'vitest'
import { ERROR_TOAST_DURATION_MS, scheduleErrorToastDismiss } from './components/ErrorToast'

afterEach(() => {
  vi.useRealTimers()
})

it('dismisses an error toast without user interaction', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  scheduleErrorToastDismiss(dismiss)

  vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS - 1)
  expect(dismiss).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(dismiss).toHaveBeenCalledOnce()
})

it('cancels dismissal when a toast is replaced', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  const cancel = scheduleErrorToastDismiss(dismiss)

  cancel()
  vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS)
  expect(dismiss).not.toHaveBeenCalled()
})
