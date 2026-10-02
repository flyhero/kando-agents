import { AGENT_KINDS, quotaVerdict, usageLevel, type AgentKind, type ChatModel, type QuotaVerdict } from '@kando/protocol'
import { useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { usePreferences, type Preferences } from '../preferences'
import { formatClock, resetText, useNow, windowLabel } from '../usage-format'

// What quotaVerdict matches a model-specific window against: everything the catalog says of it,
// since the default model names the real one only in its description.
export function modelText(model: Pick<ChatModel, 'id' | 'label' | 'description'> | undefined): string | null {
  return model ? [model.id, model.label, model.description].filter(Boolean).join(' ') : null
}

function verdictOf(agent: AgentKind, now: number, model?: string | null): QuotaVerdict {
  return quotaVerdict(useCore.getState().usage?.[agent], now, model)
}

// "5h 剩 12%", "本周 已用完 · 今天 18:00 重置": short enough for a menu row; the confirmation
// spells the wait out. null when there is nothing worth saying.
export function quotaText(verdict: QuotaVerdict, display: Preferences['usageDisplay'], now: number): string | null {
  const { window } = verdict
  if (!window) {
    return null
  }
  const stale = verdict.stale ? ' · 可能已过时' : ''
  if (verdict.state === 'exhausted') {
    const reset = window.resetsAt === null ? '' : ` · ${formatClock(window.resetsAt, now)} 重置`
    return `${windowLabel(window)} 已用完${reset}${stale}`
  }
  const used = Math.round(window.usedPercent)
  return `${windowLabel(window)} ${display === 'remaining' ? `剩 ${100 - used}%` : `已用 ${used}%`}${stale}`
}

// The agent's tightest window, for wherever it is about to be picked. Says nothing while the usage
// is unknown (signed out, an older core) rather than guessing.
export function AgentQuotaHint({ agent, model, className }: { agent: AgentKind; model?: string | null; className?: string }) {
  const usage = useCore((s) => s.usage?.[agent])
  const display = usePreferences((s) => s.usageDisplay)
  const now = useNow(60_000)
  const verdict = quotaVerdict(usage, now, model)
  const text = quotaText(verdict, display, now)
  if (!text || !verdict.window) {
    return null
  }
  const level = verdict.state === 'exhausted' || verdict.state === 'tight' ? 'critical' : usageLevel(verdict.window.usedPercent)
  return (
    <span className={['agent-quota', className].filter(Boolean).join(' ')} data-level={level}>
      {text}
    </span>
  )
}

// Chinese text sets Latin letters and digits off from Han characters with a space.
function spaced(label: string): string {
  const latin = (char: string | undefined) => char !== undefined && /[\x21-\x7e]/.test(char)
  return `${latin(label[0]) ? ' ' : ''}${label}${latin(label.at(-1)) ? ' ' : ''}`
}

// Asked before starting an agent whose quota is used up: it would stall at once. Only a nudge; the
// user may know better (a reset about to land, a credit to spend).
export function confirmQuota(agent: AgentKind, model?: string | null): boolean {
  const now = Date.now()
  const verdict = verdictOf(agent, now, model)
  if (verdict.state !== 'exhausted' || !verdict.window) {
    return true
  }
  const reset = resetText(verdict.window, now)
  const other = AGENT_KINDS.find((kind) => kind !== agent)
  const otherVerdict = other ? verdictOf(other, now) : null
  const display = usePreferences.getState().usageDisplay
  const suggestion =
    other && otherVerdict && (otherVerdict.state === 'ok' || otherVerdict.state === 'tight')
      ? `\n${AGENT_LABEL[other]} 还有额度${otherVerdict.window ? `（${quotaText(otherVerdict, display, now)}）` : ''}，可以先换成它。`
      : ''
  return window.confirm(
    `${AGENT_LABEL[agent]} 已用完${spaced(windowLabel(verdict.window))}额度${reset ? `，${reset}` : ''}。${suggestion}\n\n仍要用 ${AGENT_LABEL[agent]} 启动吗？`
  )
}
