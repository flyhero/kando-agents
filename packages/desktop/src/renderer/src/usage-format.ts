import { useEffect, useState } from 'react'
import type { UsageWindow } from '@kando/protocol'
import type { Preferences } from './preferences'

// How usage numbers read wherever they show: the status bar, and next to an agent being picked.

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return '不到 1 分钟'
  }
  if (minutes < 60) {
    return `${minutes} 分钟`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
  }
  return hours % 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${Math.floor(hours / 24)} 天`
}

export function formatClock(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === new Date(now).toDateString()) {
    return `今天 ${time}`
  }
  return `${date.toLocaleDateString('zh-CN', { weekday: 'short' })} ${time}`
}

export function windowLabel(window: UsageWindow): string {
  if (window.kind === 'session') {
    return '5h'
  }
  const period = window.kind === 'monthly' ? '本月' : '本周'
  return window.model ? `${window.model} ${period}` : period
}

export function resetText(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) {
    return ''
  }
  if (window.resetsAt <= now) {
    return '即将重置'
  }
  return `${formatDuration(window.resetsAt - now)}后重置（${formatClock(window.resetsAt, now)}）`
}

// Urgency colors always follow what is used; only the number and the fill flip.
export function shownPercent(window: UsageWindow, display: Preferences['usageDisplay']): number {
  return display === 'remaining' ? 100 - window.usedPercent : window.usedPercent
}

export function percentText(window: UsageWindow, display: Preferences['usageDisplay']): string {
  const value = Math.round(shownPercent(window, display))
  return display === 'remaining' ? `剩 ${value}%` : `${value}%`
}
