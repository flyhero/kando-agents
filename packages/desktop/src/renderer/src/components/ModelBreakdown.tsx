import type { DashboardModel } from '@kando/protocol'
import { acceptance } from '../dashboard-model'
import { AGENT_LABEL } from '../labels'
import { compact, durationText, percent } from '../stat-format'
import { AgentIcon } from './icons'

// Each agent and model of the range, with its share of the tokens.
export function ModelBreakdown({ models }: { models: readonly DashboardModel[] }) {
  const total = models.reduce((sum, row) => sum + row.tokens, 0)
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-models">
      <header className="dashboard-panel-header">
        <h3 id="dashboard-models">按 Agent 和模型</h3>
      </header>
      {models.length === 0 ? (
        <p className="dashboard-empty muted">这段时间没有运行或对话。</p>
      ) : (
        <table className="dashboard-models">
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" title="这段时间结束的任务运行">运行</th>
              <th scope="col" title="判定过的运行里直接接受的比例，判定太少时不算">接受率</th>
              <th scope="col" title="一次运行从开始到交付，含你中间的时间">耗时中位</th>
              <th scope="col" title="对话里结束的回合">回合</th>
              <th scope="col" title="任务运行和对话回合读写的 token">token</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => {
              const rate = acceptance(row.accepted, row.decided)
              return (
                <tr key={`${row.agent}:${row.model ?? ''}`}>
                  <th scope="row">
                    <span className="dashboard-model-name">
                      <AgentIcon agent={row.agent} />
                      <span className="muted">{AGENT_LABEL[row.agent]}</span>
                      {row.model ?? <span className="muted">未知模型</span>}
                    </span>
                  </th>
                  <td>{row.runs}</td>
                  <td>{rate === null ? <span className="muted">—</span> : percent(row.accepted, row.decided)}</td>
                  <td>{row.runs === 0 ? <span className="muted">—</span> : durationText(row.medianRunMs)}</td>
                  <td>{row.turns}</td>
                  <td>
                    <span className="dashboard-share">
                      {compact(row.tokens)}
                      <span className="dashboard-share-track" title={total > 0 ? percent(row.tokens, total) : undefined}>
                        <span style={{ width: `${total > 0 ? (row.tokens / total) * 100 : 0}%` }} />
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
