import { useCallback, useState } from 'react'
import { AGENT_KINDS, type AgentKind } from '@kando/protocol'
import { AGENT_LABEL } from '../labels'
import { AgentIcon, CheckIcon, ChevronDownIcon } from './icons'
import { Popover } from './Popover'

// Locked while running (the session already started with this agent) and once abandoned.
export function AgentPicker({
  agent,
  locked,
  onChange
}: {
  agent: AgentKind | null
  locked: boolean
  onChange: (agent: AgentKind | null) => void
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const label = agent ? AGENT_LABEL[agent] : '未选择'
  const pick = (next: AgentKind | null) => {
    close()
    if (next !== agent) {
      onChange(next)
    }
  }

  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button agent-button"
        aria-label={`Agent：${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={locked}
        data-tooltip={locked ? `Agent：${label}` : `Agent：${label}（点击切换）`}
        onClick={() => !locked && setOpen((current) => !current)}
      >
        <AgentIcon agent={agent} />
        <span className="agent-button-chevron">
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <Popover label="选择 agent" onClose={close}>
          {AGENT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="menu-item"
              aria-pressed={kind === agent}
              onClick={() => pick(kind)}
            >
              <AgentIcon agent={kind} />
              <span className="menu-item-title">{AGENT_LABEL[kind]}</span>
              {kind === agent && (
                <span className="menu-check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
          {agent && (
            <>
              <div className="menu-separator" />
              <button type="button" className="menu-item" onClick={() => pick(null)}>
                <AgentIcon agent={null} />
                <span className="menu-item-title">不指定</span>
              </button>
            </>
          )}
        </Popover>
      )}
    </span>
  )
}
