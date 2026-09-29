import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from './icons'

// Copies its text, and says it did with a check for a moment.
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="copy-button"
      data-copied={copied || undefined}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
