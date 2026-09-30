import { useEffect, useState } from 'react'
import type { AgentKind } from '@kando/protocol'
import { workedFor } from '../chat-tools'
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

// While a turn runs, at the end of the conversation: what the agent is at, and for how long. The
// clock ticks for the eye only; a screen reader hears what the agent does, not every second.
export function ChatWorking({ agent, doing: current, since }: { agent: AgentKind; doing: string | null; since: number | null }) {
  const doing = useSettled(current, 320)
  const [started] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="chat-working">
      <Spinner />
      <span className="chat-working-text chat-sheen" aria-live="polite">{AGENT_LABEL[agent]} 正在处理{doing ? `：${doing}` : ''}</span>
      <span className="chat-working-time" aria-hidden="true">{workedFor(Math.max(0, now - (since ?? started)))}</span>
    </div>
  )
}
