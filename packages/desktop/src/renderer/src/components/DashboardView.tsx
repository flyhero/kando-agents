import { useCallback, useEffect, useState } from 'react'
import { TASK_STATUSES, type DashboardStats } from '@kando/protocol'
import { perform, setDashboardOpen, useCore } from '../core-store'
import { DASHBOARD_RANGES, type DashboardRange } from '../dashboard-model'
import { STATUS_LABEL } from '../labels'
import { percent } from '../stat-format'
import { ActivityHeatmap } from './ActivityHeatmap'
import { DailyBars } from './DailyBars'
import { DashboardKpis } from './DashboardKpis'
import { CloseIcon, RefreshIcon } from './icons'
import { ModelBreakdown } from './ModelBreakdown'
import { Segmented } from './SettingsControls'
import { StatusIcon } from './StatusIcon'

const RANGE_OPTIONS = DASHBOARD_RANGES.map((range) => ({ value: String(range), label: `${range} 天` }))
const TIME = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

// Asked for on opening, on a new range and on refresh: the numbers move only as runs and turns end.
function useDashboard(range: DashboardRange) {
  const connected = useCore((s) => s.connection === 'connected')
  const [report, setReport] = useState<{ stats: DashboardStats; at: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const stats = await perform((rpc) => rpc.call('dashboard.stats', { range, timeZone }))
    setLoading(false)
    if (stats) setReport({ stats, at: Date.now() })
  }, [range])
  useEffect(() => {
    if (connected) void load()
  }, [connected, load])
  return { report, loading, load }
}

// What the tasks are now: the range does not apply, a task has no history of its statuses.
function TaskStatuses() {
  const tasks = useCore((s) => s.tasks)
  const all = Object.values(tasks)
  const counts = TASK_STATUSES.map((status) => ({ status, count: all.filter((task) => task.status === status).length }))
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-statuses">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-statuses">任务状态</h3>
        <span className="dashboard-panel-note">现在共 {all.length} 个</span>
      </header>
      {all.length === 0 ? (
        <p className="dashboard-empty muted">还没有任务。</p>
      ) : (
        <>
          <div className="dashboard-status-bar" aria-hidden="true">
            {counts.map(({ status, count }) => count > 0 && <span key={status} data-status={status} style={{ flexGrow: count }} />)}
          </div>
          <ul className="dashboard-status-list">
            {counts.map(({ status, count }) => (
              <li key={status}>
                <StatusIcon status={status} decorative />
                <span>{STATUS_LABEL[status]}</span>
                <span className="dashboard-status-count">{count}</span>
                <span className="dashboard-status-share muted">{percent(count, all.length)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function DashboardView() {
  const [range, setRange] = useState<DashboardRange>(7)
  const { report, loading, load } = useDashboard(range)
  const days = report?.stats.days.slice(-range) ?? []
  const empty = report !== null && report.stats.days.every((day) => day.runs === 0 && day.turns === 0)
  return (
    <section className="worktrees-page dashboard-page" aria-label="统计">
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>统计</h2>
          <p className="muted">
            任务运行和对话的用量，按这台电脑的日期计{report && ` · 更新于 ${TIME.format(report.at)}`}
          </p>
        </div>
        <Segmented
          labelId="dashboard-range"
          value={String(range)}
          options={RANGE_OPTIONS}
          onChange={(value) => setRange(DASHBOARD_RANGES.find((option) => String(option) === value) ?? 7)}
        />
        <span id="dashboard-range" hidden>时间范围</span>
        <button type="button" className="tool-button" aria-label="刷新" data-tooltip="刷新" disabled={loading} onClick={() => void load()}>
          <span className="dashboard-refresh" data-loading={loading || undefined}><RefreshIcon /></span>
        </button>
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => setDashboardOpen(false)}>
          <CloseIcon />
        </button>
      </header>
      {report === null ? (
        <p className="dashboard-empty muted">正在读取…</p>
      ) : (
        <div className="dashboard-grid">
          {empty && (
            <p className="dashboard-empty dashboard-empty-all muted">还没有运行记录。任务执行结束、对话回合结束后会计入这里。</p>
          )}
          <DashboardKpis stats={report.stats} days={days} range={range} />
          <DailyBars days={days} />
          <ActivityHeatmap days={report.stats.days} />
          <div className="dashboard-split">
            <ModelBreakdown models={report.stats.models} />
            <TaskStatuses />
          </div>
        </div>
      )}
    </section>
  )
}
