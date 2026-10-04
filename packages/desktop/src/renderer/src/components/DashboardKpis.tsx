import type { DashboardDay, DashboardStats } from '@kando/protocol'
import { acceptance, change, dayTokens, rateChange, type Change } from '../dashboard-model'
import { compact, durationText, percent } from '../stat-format'

type Kpi = { label: string; title: string; value: string; note?: string; change: Change | null; trend?: number[] }

// The range's shape at a glance; drawn in the text colour, since it only repeats the number beside it.
function Sparkline({ values }: { values: readonly number[] }) {
  const max = Math.max(...values)
  if (values.length < 2 || max === 0) return null
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 64},${22 - (value / max) * 20}`).join(' ')
  return (
    <svg className="dashboard-spark" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

const ARROW = { up: '↑', down: '↓', flat: '' } as const

function KpiCell({ kpi, range }: { kpi: Kpi; range: number }) {
  return (
    <div className="dashboard-kpi" title={kpi.title}>
      <span className="dashboard-kpi-label">{kpi.label}</span>
      <span className="dashboard-kpi-value">{kpi.value}</span>
      <span className="dashboard-kpi-foot">
        {kpi.change ? (
          <span className="dashboard-kpi-change" data-direction={kpi.change.direction}>
            {ARROW[kpi.change.direction]}{kpi.change.text}
            <span className="dashboard-kpi-since"> 较前 {range} 天</span>
          </span>
        ) : (
          <span className="dashboard-kpi-since">{kpi.note ?? `前 ${range} 天无数据`}</span>
        )}
        {kpi.trend && <Sparkline values={kpi.trend} />}
      </span>
    </div>
  )
}

// The headline numbers of the range, each against the range before it.
export function DashboardKpis({ stats, days, range }: { stats: DashboardStats; days: readonly DashboardDay[]; range: number }) {
  const { current, previous } = stats
  const rate = acceptance(current.accepted, current.decided)
  const kpis: Kpi[] = [
    { label: '任务运行', title: '这段时间结束的 agent 运行', value: String(current.runs), change: change(current.runs, previous.runs), trend: days.map((day) => day.runs) },
    {
      label: '接受率',
      title: '你判定过的运行里，直接接受的比例',
      value: rate === null ? '—' : percent(current.accepted, current.decided),
      note: rate === null ? `判定 ${current.decided} 次，样本太少` : undefined,
      change: rateChange(rate, acceptance(previous.accepted, previous.decided))
    },
    {
      label: '耗时中位',
      title: '一次运行从开始到交付，含你中间的时间',
      value: durationText(current.medianRunMs),
      change: current.medianRunMs === null || previous.medianRunMs === null ? null : change(current.medianRunMs, previous.medianRunMs)
    },
    { label: 'token 合计', title: '任务运行和对话回合读写的 token', value: compact(current.tokens), change: change(current.tokens, previous.tokens), trend: days.map(dayTokens) },
    { label: '对话回合', title: '对话里结束的回合，不含任务里的', value: String(current.turns), change: change(current.turns, previous.turns), trend: days.map((day) => day.turns) },
    {
      label: '失败 / 中断',
      title: '出错结束的回合（撞额度的也算）/ 被停下的回合',
      value: `${current.failedTurns} / ${current.interruptedTurns}`,
      note: current.turns > 0 ? `占回合的 ${percent(current.failedTurns + current.interruptedTurns, current.turns)}` : '没有回合',
      change: null
    }
  ]
  return (
    <div className="dashboard-kpis">
      {kpis.map((kpi) => <KpiCell key={kpi.label} kpi={kpi} range={range} />)}
    </div>
  )
}
