import { useState } from 'react'
import type { DashboardDay } from '@kando/protocol'
import { dayLabel } from '../dashboard-model'
import { compact } from '../stat-format'
import { Segmented } from './SettingsControls'

type Metric = 'tokens' | 'count'
const METRICS = [
  { value: 'tokens', label: 'token' },
  { value: 'count', label: '次数' }
] as const

const parts = (day: DashboardDay, metric: Metric) =>
  metric === 'tokens' ? { runs: day.runTokens, turns: day.turnTokens } : { runs: day.runs, turns: day.turns }

// Labels under the first, middle and last bars; every bar gets one when there are few.
function labelled(index: number, count: number): boolean {
  return count <= 14 || index === 0 || index === count - 1 || index === Math.floor((count - 1) / 2)
}

// Each day of the range as one bar, task runs stacked under conversation turns.
export function DailyBars({ days }: { days: readonly DashboardDay[] }) {
  const [metric, setMetric] = useState<Metric>('tokens')
  const max = Math.max(1, ...days.map((day) => parts(day, metric).runs + parts(day, metric).turns))
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-daily">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-daily">每日趋势</h3>
        <span className="dashboard-legend">
          <span className="dashboard-swatch" data-series="runs" />任务
          <span className="dashboard-swatch" data-series="turns" />对话
        </span>
        <Segmented labelId="dashboard-daily" value={metric} options={METRICS} onChange={setMetric} />
      </header>
      <div className="dashboard-bars-frame">
        <span className="dashboard-bars-max">{compact(max)}</span>
        <div className="dashboard-bars" data-dense={days.length > 45 || undefined}>
          {days.map((day, index) => {
            const { runs, turns } = parts(day, metric)
            return (
              <div
                key={day.day}
                className="dashboard-bar"
                data-tooltip={`${dayLabel(day.day)} · 任务 ${compact(runs)} · 对话 ${compact(turns)}`}
                data-tooltip-side={index < days.length / 2 ? 'top' : 'top-end'}
              >
                <div className="dashboard-bar-stack">
                  <span data-series="turns" style={{ height: `${(turns / max) * 100}%` }} />
                  <span data-series="runs" style={{ height: `${(runs / max) * 100}%` }} />
                </div>
                <span className="dashboard-bar-label">{labelled(index, days.length) ? dayLabel(day.day) : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
