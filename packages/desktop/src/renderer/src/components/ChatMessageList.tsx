import { useCallback, useRef, useState } from 'react'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { ListIcon } from './icons'

export type SentMessage = { key: string; text: string }

// Every message the user sent, newest first, to jump back to one; beside ↑, which steps back one
// at a time.
export function ChatMessageList({ messages, onJump }: { messages: readonly SentMessage[]; onJump: (key: string) => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  if (messages.length < 2) return null
  return (
    <>
      <button
        ref={button}
        type="button"
        className="tool-button"
        aria-label="你发过的消息"
        data-tooltip="你发过的消息"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          const box = button.current?.getBoundingClientRect()
          if (at) close()
          else if (box) setAt({ x: box.right, y: box.top })
        }}
      >
        <ListIcon />
      </button>
      {at && (
        <ContextMenu at={at} align="end" above trigger={button.current} label="你发过的消息" onClose={close}>
          <div className="chat-picker-heading">你发过的消息</div>
          {[...messages].reverse().map((message, index) => (
            <MenuItem
              key={message.key}
              label={`${messages.length - index}. ${message.text.replace(/\s+/g, ' ').trim() || '（只有图片）'}`}
              onSelect={() => {
                close()
                onJump(message.key)
              }}
            />
          ))}
        </ContextMenu>
      )}
    </>
  )
}
