import type { ChatItem } from '@kando/protocol'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { formatTokens, subagentBrief } from '../chat-tools'
import { durationText } from '../stat-format'
import { ChatMarkdown } from './ChatMarkdown'
import { CheckIcon, ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'
import { ChatToolIcon } from './ChatToolIcon'
import { useJustFinished } from '../chat-motion'
import { ChatCopyRegion } from './ChatCopyRegion'
import { copyTextForItem } from '../message-copy'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const failed = (tool: ToolItem) => tool.status === 'failed' || tool.status === 'denied' || tool.status === 'interrupted'

// `finished` draws the tick in, for one that came back while the user watched.
function SubagentMark({ tool, finished }: { tool: ToolItem; finished: boolean }) {
  if (tool.status === 'running') return <Spinner label="还在进行，回来后这里会有它的报告" />
  if (failed(tool)) return <span className="chat-subagent-mark" data-failed role="img" aria-label="没有完成" />
  return <span className="chat-subagent-mark" data-finished={finished || undefined} role="img" aria-label="完成"><CheckIcon /></span>
}

// One subagent: its kind and task, opening onto what it was told and what it reported back.
// `lane` sets the phase of its running light apart from its siblings', so parallel ones read as
// parallel.
function Subagent({ tool, lane }: { tool: ToolItem; lane: number }) {
  const [open, setOpen] = useDisclosure(`agent:${itemKey(tool)}`)
  const brief = subagentBrief(tool.input)
  const finished = useJustFinished(tool.status === 'running')
  return (
    <ChatCopyRegion text={copyTextForItem(tool)}>
    <div className="chat-subagent" data-status={tool.status} data-finished={finished || undefined} style={{ '--chat-lane': lane }}>
      <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChatToolIcon name={tool.name} status={tool.status} />
        <SubagentMark tool={tool} finished={finished} />
        <span className="chat-subagent-prefix">子 Agent:</span>
        {brief.kind && <span className="chat-tool-name">{brief.kind}</span>}
        <span className="chat-subagent-chip" title={tool.title}>{tool.title}</span>
        {tool.metrics && tool.metrics.tools === 0 && tool.metrics.tokens === 0 && tool.metrics.durationMs > 0 && (
          // Some agents report a subagent's time alone (Cursor).
          <span className="chat-subagent-metrics">用了 {durationText(tool.metrics.durationMs)}</span>
        )}
        {tool.metrics && (tool.metrics.tools > 0 || tool.metrics.tokens > 0) && (
          <span className="chat-subagent-metrics" title={tool.metrics.durationMs ? `用了 ${Math.round(tool.metrics.durationMs / 1000)} 秒` : undefined}>
            {tool.metrics.tools > 0 && <span>{tool.metrics.tools} 工具</span>}
            {tool.metrics.tools > 0 && tool.metrics.tokens > 0 && <span className="chat-subagent-metrics-dot">·</span>}
            {tool.metrics.tokens > 0 && <span>{formatTokens(tool.metrics.tokens)}</span>}
          </span>
        )}
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      {open && (
        <div className="chat-subagent-body">
          {brief.prompt && (
            <section>
              <h4 className="chat-subagent-label">指令</h4>
              <ChatCopyRegion text={brief.prompt}><div className="chat-subagent-text">{brief.prompt}</div></ChatCopyRegion>
            </section>
          )}
          <section>
            <h4 className="chat-subagent-label">结果</h4>
            {tool.output
              ? <ChatCopyRegion text={tool.output}><div className="chat-subagent-result"><ChatMarkdown text={tool.output} /></div></ChatCopyRegion>
              : <p className="muted">{tool.status === 'running' ? '还在进行…' : '没有结果'}</p>}
          </section>
        </div>
      )}
    </div>
    </ChatCopyRegion>
  )
}

// Subagents the agent sent off together, in a card of their own: a line for how many and how they
// are doing, then each of them.
export function ChatSubagents({ tools }: { tools: readonly ToolItem[] }) {
  const running = tools.filter((tool) => tool.status === 'running').length
  const broken = tools.filter(failed).length
  return (
    <div className="chat-subagents">
      {tools.length > 1 && (
        <div className="chat-subagents-summary">
          派出 {tools.length} 个子 agent
          {running > 0 && ` · ${running} 个进行中`}
          {broken > 0 && <span className="chat-tool-status" data-status="failed"> · {broken} 个没有完成</span>}
        </div>
      )}
      {tools.map((tool, index) => <Subagent key={tool.id} tool={tool} lane={index} />)}
    </div>
  )
}
