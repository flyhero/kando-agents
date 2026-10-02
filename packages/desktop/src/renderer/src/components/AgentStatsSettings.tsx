import { Fragment, useEffect, useState } from 'react'
import { AGENT_KINDS, MIN_DECIDED_RUNS, type AgentStats } from '@kando/protocol'
import { perform, useAgentStatsSupported, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { AgentIcon } from './icons'

const TOKENS = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

function durationText(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
}

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`

function StatsRow({ stats }: { stats: AgentStats }) {
  const enough = stats.decided >= MIN_DECIDED_RUNS
  return (
    <tr>
      <th scope="row" className="settings-stats-model">
        {stats.model ?? <span className="muted">未知模型</span>}
      </th>
      <td>
        {stats.decided} / {stats.runs}
      </td>
      {enough ? (
        <>
          <td>{percent(stats.accepted, stats.decided)}</td>
          <td>{percent(stats.continued, stats.decided)}</td>
          <td>{percent(stats.redone, stats.decided)}</td>
        </>
      ) : (
        <td colSpan={3} className="settings-stats-few muted">
          样本太少
        </td>
      )}
      <td>{stats.endedTerminal > 0 ? `${stats.abnormalExits} / ${stats.endedTerminal}` : '—'}</td>
      <td>{durationText(stats.medianDurationMs)}</td>
      <td>{stats.medianTokens === null ? '—' : TOKENS.format(stats.medianTokens)}</td>
    </tr>
  )
}

// Read on opening: runs change only as tasks finish, so nothing here needs to be live.
export function AgentStatsSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const supported = useAgentStatsSupported()
  const [stats, setStats] = useState<AgentStats[] | null>(null)

  useEffect(() => {
    if (connected && supported) {
      void perform((rpc) => rpc.call('agents.stats', {})).then((rows) => setStats(rows ?? []))
    }
  }, [connected, supported])

  if (!connected) {
    return <p className="settings-empty">连接到 Kando core 后才能查看。</p>
  }
  if (!supported) {
    return <p className="settings-empty">当前运行的 Kando core 还不记录任务运行，升级后才能查看。</p>
  }
  if (stats === null) {
    return <p className="settings-empty">正在读取…</p>
  }
  if (stats.length === 0) {
    return <p className="settings-empty">还没有运行记录。任务执行结束后会出现在这里，你验收、继续修改或重做之后计入比率。</p>
  }
  return (
    <>
      <table className="settings-stats">
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col" title="已判定 / 已结束的运行">判定</th>
            <th scope="col" title="你直接接受的结果">接受</th>
            <th scope="col" title="你要求继续修改的结果">继续修改</th>
            <th scope="col" title="你放弃、重做的结果">重做</th>
            <th scope="col" title="终端运行里出错退出的次数">异常退出</th>
            <th scope="col" title="从开始执行到交付，含你中间的时间">耗时中位</th>
            <th scope="col" title="聊天运行用掉的 token">token 中位</th>
          </tr>
        </thead>
        <tbody>
          {AGENT_KINDS.map((agent) => {
            const rows = stats.filter((each) => each.agent === agent)
            return rows.length === 0 ? null : (
              <Fragment key={agent}>
                <tr className="settings-stats-agent">
                  <th scope="rowgroup" colSpan={8}>
                    <AgentIcon agent={agent} />
                    {AGENT_LABEL[agent]}
                  </th>
                </tr>
                {rows.map((row) => (
                  <StatsRow key={row.model ?? ''} stats={row} />
                ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <p className="settings-stats-note muted">
        比率的分母是你判定过的运行，每一次要么被接受，要么被要求继续修改，要么被重做。判定少于 {MIN_DECIDED_RUNS} 次的不算比率。终端里运行的 agent 不报告模型和 token，归在「未知模型」。
      </p>
    </>
  )
}
