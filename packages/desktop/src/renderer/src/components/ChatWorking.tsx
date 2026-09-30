import { useEffect, useState } from 'react'
import type { AgentKind } from '@kando/protocol'
import { formatTokens, workedFor } from '../chat-tools'
import { AGENT_LABEL } from '../labels'
import { Spinner } from './Spinner'

// A value once it has held still for a moment: a headline cut from streaming text would otherwise
// change with every token.
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

// What kind of thing the agent is at, when nothing more specific is known.
export type WorkingPhase = 'tools' | 'thinking' | 'replying' | 'waiting' | 'working'
const PHASE: Record<WorkingPhase, string> = { tools: '运行工具', thinking: '思考', replying: '写回复', waiting: '等子 agent', working: '处理' }

// While a turn runs, at the end of the conversation: a line for what the agent is at, then the
// numbers under it, as Claude Code's own status reads: how long, how many tokens written, how many
// subagents out, and what kind of step this is. The clock ticks for the eye only; a screen reader
// hears what the agent does, not every second.
export function ChatWorking({ agent, doing: current, phase, tokens, background, since }: {
  agent: AgentKind
  doing: string | null
  phase: WorkingPhase
  // Output tokens the turn has written so far, where the agent reports them as it goes.
  tokens: number | null
  // Subagents working in the background.
  background: number
  since: number | null
}) {
  const doing = useSettled(current, 320)
  const [started] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const parts = [
    workedFor(Math.max(0, now - (since ?? started))),
    ...(tokens !== null && tokens > 0 ? [`${formatTokens(tokens)} tokens`] : []),
    ...(background > 0 ? [`${background} 个子 agent`] : []),
    `${PHASE[phase]}中…`
  ]
  return (
    <div className="chat-working">
      <div className="chat-working-head">
        <span className="chat-working-text chat-sheen" aria-live="polite">{doing ?? `${AGENT_LABEL[agent]} 正在处理`}</span>
      </div>
      <div className="chat-working-meta" aria-hidden="true">
        <Spinner />
        {parts.map((part, index) => (
          <span key={index} className="chat-working-part">
            {index > 0 && <span className="chat-working-dot">·</span>}
            {part}
          </span>
        ))}
      </div>
    </div>
  )
}
