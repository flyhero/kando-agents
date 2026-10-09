import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  AGENT_KINDS,
  tightestWindow,
  usageLevel,
  type AgentKind,
  type AgentUsage,
  type ResetCredits,
  type UsageWindow
} from '@kando/protocol'
import { refreshUsage, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { usePreferences } from '../preferences'
import { formatClock, formatDuration, percentText, resetText, shownPercent, useNow, windowLabel } from '../usage-format'
import { AgentIcon } from './icons'

const AGENT_CLI: Record<AgentKind, string> = { claude: 'claude', codex: 'codex', cursor: 'agent' }

function errorText(usage: AgentUsage): string {
  return usage.error === 'auth-expired'
    ? `登录凭据已过期，运行一次 ${AGENT_CLI[usage.agent]} 即可刷新`
    : '读取失败，稍后自动重试'
}

// A credit this close to expiring is worth a nudge.
const EXPIRING_SOON_MS = 24 * 60 * 60_000

const expiresSoon = (expiresAt: number | null, now: number) => expiresAt !== null && expiresAt - now < EXPIRING_SOON_MS

function expiryText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) {
    return '没有过期时间'
  }
  if (expiresAt <= now) {
    return '已过期'
  }
  const date = new Date(expiresAt)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time} 过期（还有 ${formatDuration(expiresAt - now)}）`
}

function clearsText(clears: readonly UsageWindow['kind'][]): string {
  const session = clears.includes('session')
  const weekly = clears.includes('weekly')
  if (session && weekly) {
    return '清零 5h 和每周额度'
  }
  return session ? '清零 5h 额度' : weekly ? '清零每周额度' : ''
}

// Where a reset can actually be used: Claude's cannot be from a terminal.
const WHERE_TO_USE: Record<AgentKind, string> = {
  claude: '在 claude.ai 网页版或 Claude Desktop 的 设置 → Usage 里使用',
  codex: '在 Codex 的用量设置里使用',
  cursor: '在 Cursor 的用量设置里查看'
}

function ResetCreditList({ agent, credits, now }: { agent: AgentKind; credits: ResetCredits; now: number }) {
  if (credits.blockedBy === 'cli_version') {
    return <div className="usage-card-credits muted">升级 Claude Code 后，这里会显示可用的重置卡</div>
  }
  const labels = [...new Set(credits.credits.flatMap((credit) => (credit.label ? [credit.label] : [])))]
  const unlisted = credits.available - credits.credits.length
  return (
    <div className="usage-card-credits">
      <div className="usage-card-credits-title">可用重置卡 {credits.available} 张</div>
      {labels.map((label) => (
        <div key={label} className="usage-card-credit-label">
          {label}
        </div>
      ))}
      {credits.credits.map((credit, index) => {
        const clears = clearsText(credit.clears)
        return (
          <div key={index} className="usage-card-credit" data-soon={expiresSoon(credit.expiresAt, now) || undefined}>
            {expiryText(credit.expiresAt, now)}
            {clears && ` · ${clears}`}
          </div>
        )
      })}
      {unlisted > 0 && <div className="usage-card-credit">另有 {unlisted} 张没有给出过期时间</div>}
      <div className="usage-card-credits-hint">{WHERE_TO_USE[agent]}</div>
    </div>
  )
}

const CARD_WIDTH = 340
// Hovering past on the way somewhere else should not flash a card.
const CARD_DELAY_MS = 300
const CARD_HIDE_DELAY_MS = 200

// Every window in full, above the segment. Rendered into <body> at a fixed position: inside the
// status bar it would be clipped, and a button may not contain it.
function UsageCard({ usage, now, anchor, id, cardRef, onEnter, onLeave, onRefresh, refreshing }: {
  usage: AgentUsage
  now: number
  anchor: DOMRect
  id: string
  cardRef: RefObject<HTMLDivElement | null>
  onEnter: () => void
  onLeave: () => void
  onRefresh: () => void
  refreshing: boolean
}) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8))
  const bottom = window.innerHeight - anchor.top + 6
  const footer =
    usage.status === 'error'
      ? `${errorText(usage)}${usage.windows.length > 0 ? `（数据停留在 ${formatClock(usage.updatedAt, now)}）` : ''}`
      : `${formatDuration(now - usage.updatedAt)}前更新`
  return (
    <div
      id={id}
      ref={cardRef}
      role="dialog"
      aria-label={`${AGENT_LABEL[usage.agent]} 用量额度`}
      className="usage-card"
      style={{ left, bottom, width: CARD_WIDTH }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={onLeave}
    >
      <div className="usage-card-title">
        {AGENT_LABEL[usage.agent]}
        {usage.plan && <span className="muted"> · {usage.plan}</span>}
      </div>
      {usage.windows.map((window) => {
        const used = Math.round(window.usedPercent)
        return (
          <div key={`${window.kind}-${window.model}`} className="usage-card-row" data-level={usageLevel(window.usedPercent)}>
            <span className="usage-card-label">{windowLabel(window)}</span>
            <span className="usage-meter" aria-hidden="true">
              <span style={{ width: `${used}%` }} />
            </span>
            <span className="usage-card-value">
              已用 {used}%，剩余 {100 - used}%
            </span>
            {window.resetsAt !== null && <span className="usage-card-reset">{resetText(window, now)}</span>}
          </div>
        )
      })}
      {usage.resetCredits && (usage.resetCredits.available > 0 || usage.resetCredits.blockedBy) && (
        <ResetCreditList agent={usage.agent} credits={usage.resetCredits} now={now} />
      )}
      <div className="usage-card-footer">
        <span>{footer}</span>
        <button type="button" className="link-button usage-card-refresh" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? '刷新中…' : '立即刷新'}
        </button>
      </div>
    </div>
  )
}

// Model-specific caps only take footer space once they are the ones about to bite.
function inlineWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.filter((window) => window.model === null || usageLevel(window.usedPercent) !== 'normal')
}

function UsageSegment({ usage, now }: { usage: AgentUsage; now: number }) {
  const display = usePreferences((s) => s.usageDisplay)
  const windows = inlineWindows(usage.windows)
  // The meter follows the numbers beside it, so a model's cap moves it once it is shown.
  const tightest = tightestWindow(windows)
  const cardId = useId()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pinned, setPinned] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const close = useCallback(() => {
    clearTimeout(timer.current)
    setPinned(false)
    setAnchor(null)
  }, [])
  const show = (element: HTMLElement, delay: number) => {
    if (pinned) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor(element.getBoundingClientRect()), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    if (!pinned) timer.current = setTimeout(() => setAnchor(null), CARD_HIDE_DELAY_MS)
  }
  const keepOpen = () => clearTimeout(timer.current)
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshUsage()
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!anchor) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !card.current?.contains(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, close])
  useEffect(() => {
    if (pinned) card.current?.querySelector('button')?.focus()
  }, [pinned])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="usage-segment"
        data-stale={usage.status === 'error' || undefined}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? cardId : undefined}
        onMouseEnter={(event) => show(event.currentTarget, CARD_DELAY_MS)}
        onMouseLeave={hide}
        onClick={(event) => {
          if (pinned) close()
          else {
            clearTimeout(timer.current)
            setAnchor(event.currentTarget.getBoundingClientRect())
            setPinned(true)
          }
        }}
      >
        {/* Just the mark: the card that opens on hover leads with the full name. */}
        <span className="usage-agent" role="img" aria-label={AGENT_LABEL[usage.agent]}>
          <AgentIcon agent={usage.agent} />
        </span>
        {tightest && (
          <span className="usage-meter" data-level={usageLevel(tightest.usedPercent)} aria-hidden="true">
            <span style={{ width: `${shownPercent(tightest, display)}%` }} />
          </span>
        )}
        {windows.map((window, index) => (
          <span key={`${window.kind}-${window.model}`} className="usage-window" data-level={usageLevel(window.usedPercent)}>
            {index > 0 && <span className="usage-separator">·</span>}
            {windowLabel(window)} {percentText(window, display)}
          </span>
        ))}
        {usage.resetCredits && usage.resetCredits.available > 0 && (
          <span className="usage-credits" data-soon={expiresSoon(usage.resetCredits.credits[0]?.expiresAt ?? null, now) || undefined}>
            重置卡 {usage.resetCredits.available}
          </span>
        )}
        {usage.status === 'error' && (
          <span className="usage-stale" role="img" aria-label={errorText(usage)}>
            ⚠
          </span>
        )}
      </button>
      {anchor && createPortal(
        <UsageCard
          usage={usage}
          now={now}
          anchor={anchor}
          id={cardId}
          cardRef={card}
          onEnter={keepOpen}
          onLeave={hide}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
        />,
        document.body
      )}
    </>
  )
}

export function UsageBar() {
  const usage = useCore((s) => s.usage)
  const visible = usePreferences((s) => s.showUsage)
  const now = useNow(60_000)

  // An older core has no usage methods: show nothing rather than a dead segment.
  if (usage === null || !visible) {
    return null
  }
  const known = AGENT_KINDS.map((agent) => usage[agent]).filter((entry) => entry !== undefined)
  const shown = known.filter((entry) => entry.status !== 'signed-out')

  return (
    <div className="statusbar-group" aria-label="Agent 用量额度">
      {known.length === 0 && <span className="statusbar-hint">正在读取用量额度…</span>}
      {known.length > 0 && shown.length === 0 && (
        <span className="statusbar-hint">未检测到 Claude Code、Codex 或 Cursor 的登录，登录后这里会显示用量额度</span>
      )}
      {shown.map((entry) => (
        <UsageSegment key={entry.agent} usage={entry} now={now} />
      ))}
    </div>
  )
}
