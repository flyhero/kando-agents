import { useEffect } from 'react'
import { dismissError } from '../core-store'
import { WarningIcon } from './icons'

export const ERROR_TOAST_DURATION_MS = 5_000

export function scheduleErrorToastDismiss(dismiss: () => void): () => void {
  const timer = setTimeout(dismiss, ERROR_TOAST_DURATION_MS)
  return () => clearTimeout(timer)
}

export function ErrorToast({ message }: { message: string }) {
  useEffect(() => scheduleErrorToastDismiss(dismissError), [message])

  return (
    <div className="toast" role="alert" aria-atomic="true">
      <span className="toast-icon" aria-hidden="true"><WarningIcon /></span>
      <span className="toast-message">{message}</span>
    </div>
  )
}
