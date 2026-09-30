import type { ChatItem } from '@kando/protocol'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { subagentBrief } from '../chat-tools'
import { ChatMarkdown } from './ChatMarkdown'
import { CheckIcon, ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const failed = (tool: ToolItem) => tool.status === 'failed' || tool.status === 'denied' || tool.status === 'interrupted'

function SubagentMark({ tool }: { tool: ToolItem }) {
  if (tool.status === 'running') return <Spinner label="进行中" />
  if (failed(tool)) return <span className="chat-subagent-mark" data-failed role="img" aria-label="没有完成" />
  return <span className="chat-subagent-mark" role="img" aria-label="完成"><CheckIcon /></span>
}

// One subagent: its kind and task, opening onto what it was told and what it reported back.
function Subagent({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useDisclosure(`agent:${itemKey(tool)}`)
  const brief = subagentBrief(tool.input)
  return (
    <div className="chat-subagent">
      <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SubagentMark tool={tool} />
        <span className="chat-subagent-prefix">子 agent:</span>
        {brief.kind && <span className="chat-tool-name">{brief.kind}</span>}
        <span className="chat-subagent-chip" title={tool.title}>{tool.title}</span>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      {open && (
        <div className="chat-subagent-body">
          {brief.prompt && (
            <section>
              <h4 className="chat-subagent-label">指令</h4>
              <div className="chat-subagent-text">{brief.prompt}</div>
            </section>
          )}
          <section>
            <h4 className="chat-subagent-label">结果</h4>
            {tool.output
              ? <div className="chat-subagent-result"><ChatMarkdown text={tool.output} /></div>
              : <p className="muted">{tool.status === 'running' ? '还在进行…' : '没有结果'}</p>}
          </section>
        </div>
      )}
    </div>
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
      {tools.map((tool) => <Subagent key={tool.id} tool={tool} />)}
    </div>
  )
}
