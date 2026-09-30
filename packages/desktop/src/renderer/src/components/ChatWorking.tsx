import { useEffect, useState } from 'react'
import { formatTokens, workedFor } from '../chat-tools'
import { Spinner } from './Spinner'

// What kind of thing the agent is at, when nothing more specific is known.
export type WorkingPhase = 'tools' | 'thinking' | 'replying' | 'waiting' | 'asking' | 'working'
const PHASE: Record<WorkingPhase, string> = { tools: '运行工具', thinking: '思考', replying: '写回复', waiting: '等子 agent', asking: '等你回答', working: '处理' }

// While a turn runs, at the end of the conversation: the numbers that say how it goes, as Claude
// Code's own status reads: how long, how many tokens written, how many subagents out, and what
// kind of step this is. What the agent is at shows in the conversation itself, just above. The
// clock ticks for the eye only; a screen reader hears the phase, not every second.
export function ChatWorking({ phase, tokens, background, since }: {
  phase: WorkingPhase
  // Output tokens the turn has written so far, where the agent reports them as it goes.
  tokens: number | null
  // Subagents working in the background.
  background: number
  since: number | null
}) {
  const [started] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const parts = [
    workedFor(Math.max(0, now - (since ?? started))),
    ...(tokens !== null && tokens > 0 ? [`${formatTokens(tokens)} tokens`] : []),
    ...(background > 0 ? [`${background} 个子 agent`] : [])
  ]
  return (
    <div className="chat-working" role="status">
      <Spinner />
      {parts.map((part, index) => (
        <span key={index} className="chat-working-part" aria-hidden="true">
          {index > 0 && <span className="chat-working-dot">·</span>}
          {part}
        </span>
      ))}
      <span className="chat-working-part"><span className="chat-working-dot" aria-hidden="true">·</span><span className={phase === 'asking' ? undefined : 'chat-sheen'}>{PHASE[phase]}{phase === 'asking' ? '' : '中…'}</span></span>
    </div>
  )
}
