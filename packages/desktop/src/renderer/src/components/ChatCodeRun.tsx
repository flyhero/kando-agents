import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { runsAtOnce } from '../code-commands'
import { runInTerminal, type RunScope } from '../code-run'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ChevronDownIcon, PlayIcon } from './icons'

// Where the chat around a reply runs its commands; none outside a conversation's chat (a plan,
// a subagent's result), and none for a reply still being written.
export const ChatRunScope = createContext<RunScope | null>(null)
export const ChatRunnable = createContext(false)

// Beside a shell block's copy button: run it in the conversation's terminal tab. A single line runs
// at once and its menu offers pasting instead; several lines are only ever pasted, for the user's Enter.
export function ChatCodeRun({ command }: { command: string }) {
  const scope = useContext(ChatRunScope)
  const runnable = useContext(ChatRunnable)
  const more = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  if (!scope || !runnable) return null
  const single = runsAtOnce(command)
  return (
    <span className="chat-code-run">
      <button
        type="button"
        className="chat-code-run-button"
        data-tooltip={single ? '在这条会话的终端里运行' : '粘贴到这条会话的终端，确认后按回车运行'}
        data-tooltip-side="top-end"
        onClick={() => void runInTerminal(scope, command)}
      >
        <PlayIcon />{single ? '运行' : '粘贴到终端'}
      </button>
      {single && (
        <button
          ref={more}
          type="button"
          className="chat-code-run-more"
          aria-label="更多运行方式"
          aria-haspopup="menu"
          aria-expanded={at !== null}
          onClick={() => {
            const box = more.current?.getBoundingClientRect()
            if (box) setAt(at ? null : { x: box.right, y: box.bottom + 4 })
          }}
        >
          <ChevronDownIcon />
        </button>
      )}
      {at && (
        <ContextMenu at={at} align="end" trigger={more.current} label="运行方式" onClose={close}>
          <MenuItem label="粘贴到终端" hint="不执行，看过再按回车" onSelect={() => { close(); void runInTerminal(scope, command, false) }} />
        </ContextMenu>
      )}
    </span>
  )
}
