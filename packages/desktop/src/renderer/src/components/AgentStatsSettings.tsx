import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { AGENT_KINDS, MIN_DECIDED_RUNS, type AgentKind, type AgentStats, type ConversationStats } from '@kando/protocol'
import { workedFor } from '../chat-tools'
import { perform, useAgentStatsSupported, useConversationStatsSupported, useCore } from '../core-store'
import { AGENT_LABEL } from '../labels'
import { durationText, percent, tokens } from '../stat-format'
import { AgentIcon } from './icons'

// What core reported, fetched once on opening: the numbers move only as runs and turns end.
function useReport<T>(supported: boolean, read: () => Promise<T[] | null>): T[] | null {
  const connected = useCore((s) => s.connection === 'connected')
  const [rows, setRows] = useState<T[] | null>(null)
  useEffect(() => {
    // `read` is the same call every render; only connecting again asks anew.
    if (connected && supported) void read().then((result) => setRows(result ?? []))
  }, [connected, supported])
  return rows
}

// One table, rows grouped under each agent and named by model.
function ByAgent<T extends { agent: AgentKind; model: string | null }>({ rows, columns, cells }: {
  rows: readonly T[]
  columns: ReadonlyArray<{ label: string; title: string }>
  cells: (row: T) => ReactNode
}) {
  return (
    <table className="settings-stats">
      <thead>
        <tr>
          <th scope="col">模型</th>
          {columns.map((column) => (
            <th key={column.label} scope="col" title={column.title}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {AGENT_KINDS.map((agent) => {
          const own = rows.filter((row) => row.agent === agent)
          return own.length === 0 ? null : (
            <Fragment key={agent}>
              <tr className="settings-stats-agent">
                <th scope="rowgroup" colSpan={columns.length + 1}>
                  <AgentIcon agent={agent} />
                  {AGENT_LABEL[agent]}
                </th>
              </tr>
              {own.map((row) => (
                <tr key={row.model ?? ''}>
                  <th scope="row" className="settings-stats-model">
                    {row.model ?? <span className="muted">未知模型</span>}
                  </th>
                  {cells(row)}
                </tr>
              ))}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

const TASK_COLUMNS = [
  { label: '判定', title: '已判定 / 已结束的运行' },
  { label: '接受', title: '你直接接受的结果' },
  { label: '继续修改', title: '你要求继续修改的结果' },
  { label: '重做', title: '你放弃、重做的结果' },
  { label: '耗时中位', title: '从开始执行到交付，含你中间的时间' },
  { label: 'token 中位', title: '一次运行用掉的 token' }
]

function TaskCells({ stats }: { stats: AgentStats }) {
  const enough = stats.decided >= MIN_DECIDED_RUNS
  return (
    <>
      <td>{stats.decided} / {stats.runs}</td>
      {enough ? (
        <>
          <td>{percent(stats.accepted, stats.decided)}</td>
          <td>{percent(stats.continued, stats.decided)}</td>
          <td>{percent(stats.redone, stats.decided)}</td>
        </>
      ) : (
        <td colSpan={3} className="settings-stats-few muted">样本太少</td>
      )}
      <td>{durationText(stats.medianDurationMs)}</td>
      <td>{tokens(stats.medianTokens)}</td>
    </>
  )
}

function TaskStats() {
  const supported = useAgentStatsSupported()
  const stats = useReport(supported, () => perform((rpc) => rpc.call('agents.stats', {})))
  if (!supported) return <p className="settings-empty">当前运行的 Kando core 还不记录任务运行，升级后才能查看。</p>
  if (stats === null) return <p className="settings-empty">正在读取…</p>
  if (stats.length === 0) {
    return <p className="settings-empty">还没有任务的运行记录。任务执行结束后会出现在这里，你验收、继续修改或重做之后计入比率。</p>
  }
  return (
    <>
      <ByAgent rows={stats} columns={TASK_COLUMNS} cells={(row) => <TaskCells stats={row} />} />
      <p className="settings-stats-note muted">
        比率的分母是你判定过的运行，每一次要么被接受，要么被要求继续修改，要么被重做。判定少于 {MIN_DECIDED_RUNS} 次的不算比率。
      </p>
    </>
  )
}

const CONVERSATION_COLUMNS = [
  { label: '会话', title: '有回合计入的会话数' },
  { label: '回合', title: '结束了的回合' },
  { label: '失败', title: '出错结束的回合，撞额度的也算在内' },
  { label: '中断', title: '你停下的，或 Agent 退出时还没结束的回合' },
  { label: '撞额度', title: '因为用量额度用完而失败的回合' },
  { label: '每回合耗时', title: 'Agent 每个回合自己工作的时间，中位数' },
  { label: '每回合 token', title: '每个回合读写的 token，中位数' },
  { label: 'token 合计', title: '所有回合读写的 token 加起来' }
]

// A count, with its share of the turns once there are enough of them for a share to mean much.
function share(count: number, turns: number): string {
  return turns >= MIN_DECIDED_RUNS && count > 0 ? `${count}（${percent(count, turns)}）` : String(count)
}

function ConversationCells({ stats }: { stats: ConversationStats }) {
  return (
    <>
      <td>{stats.conversations}</td>
      <td>{stats.turns}</td>
      <td>{share(stats.failed, stats.turns)}</td>
      <td>{share(stats.interrupted, stats.turns)}</td>
      <td>{stats.usageLimits}</td>
      <td>{stats.medianTurnMs === null ? '—' : workedFor(stats.medianTurnMs)}</td>
      <td>{tokens(stats.medianTurnTokens)}</td>
      <td>{tokens(stats.totalTokens)}</td>
    </>
  )
}

function ConversationUsage() {
  const supported = useConversationStatsSupported()
  const stats = useReport(supported, () => perform((rpc) => rpc.call('agents.conversationStats', {})))
  if (!supported) return <p className="settings-empty">当前运行的 Kando core 还不统计会话，升级后才能查看。</p>
  if (stats === null) return <p className="settings-empty">正在读取…</p>
  if (stats.length === 0) {
    return <p className="settings-empty">还没有会话的回合记录。聊天界面里的会话每结束一个回合，就会计入这里。</p>
  }
  return (
    <>
      <ByAgent rows={stats} columns={CONVERSATION_COLUMNS} cells={(row) => <ConversationCells stats={row} />} />
      <p className="settings-stats-note muted">
        会话没有验收，这里只看花了多少、断了几次，不评好坏。token 含缓存读到的部分，和聊天里每个回合显示的一样。也包括这项统计加入之前的会话。
      </p>
    </>
  )
}

export function AgentStatsSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  if (!connected) {
    return <p className="settings-empty">连接到 Kando core 后才能查看。</p>
  }
  return (
    <>
      <h3 className="settings-stats-heading">任务</h3>
      <TaskStats />
      <h3 className="settings-stats-heading">会话</h3>
      <ConversationUsage />
    </>
  )
}
