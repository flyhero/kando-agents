// How the stats pages write their numbers.
const COMPACT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export function durationText(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
}

export const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`
export const compact = (value: number) => COMPACT.format(value)
export const tokens = (value: number | null) => (value === null ? '—' : compact(value))
