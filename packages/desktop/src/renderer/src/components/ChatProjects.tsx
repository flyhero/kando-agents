import { useCallback, useRef, useState } from 'react'
import { checkEditAdditionalProjects, MAX_TASK_REPOS, type Conversation } from '@kando/protocol'
import { perform, useCore } from '../core-store'
import { canPickFolder, pickFolder } from '../desktop-bridge'
import { reasonText } from '../labels'
import { ContextMenu, type MenuPoint } from './ContextMenu'
import { CheckIcon, ChevronDownIcon, FolderIcon } from './icons'
import { parentDir, projectName } from './ProjectPicker'

// Why the additional projects cannot change right now, as the menu says it.
function blockerNote(conversation: Conversation, supported: boolean): string | null {
  if (!supported) return '这个 core 还不能改会话的项目'
  const blocker = checkEditAdditionalProjects(conversation)
  if (blocker === 'task-conversation') return '任务的项目在任务详情里改'
  return blocker ? reasonText(blocker, blocker) : null
}

// The dock header's first chip: where the conversation works. The primary is the cwd its session
// began in; the others come and go from the menu, which restarts an idle agent on its session.
export function ChatProjects({ conversation }: { conversation: Conversation }) {
  const supported = useCore((s) => s.rpc?.features.includes('conversation-projects') ?? false)
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const [recent, setRecent] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setAt(null), [])
  const [primary, ...extras] = conversation.projectPaths
  if (!primary) return null
  const note = blockerNote(conversation, supported)
  const full = conversation.projectPaths.length >= MAX_TASK_REPOS
  const open = async () => {
    const box = button.current?.getBoundingClientRect()
    if (!box) return
    setAt({ x: box.left, y: box.top })
    if (note) return
    const found = await perform((rpc) => rpc.call('projects.recent', {}))
    setRecent((found ?? []).filter((each) => !conversation.projectPaths.includes(each)))
  }
  const apply = async (next: readonly string[]) => {
    setAt(null)
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.setAdditionalProjects', { id: conversation.id, projectPaths: [...next] }))
    setBusy(false)
  }
  const browse = async () => {
    setAt(null)
    const picked = await pickFolder(parentDir(primary))
    if (picked) await apply([...extras, picked])
  }
  // The agent is given its directories at launch.
  const footer = note ?? (conversation.sessionId !== null ? 'Agent 会在同一个会话里重启，拿到新的目录' : null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className="chat-projects"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`会话的项目：${conversation.projectPaths.map(projectName).join('、')}`}
        title={[`主项目：${primary}`, ...extras].join('\n')}
        disabled={busy}
        onClick={() => (at ? close() : void open())}
      >
        <FolderIcon />
        <span className="chat-projects-name">{projectName(primary)}</span>
        {extras.length > 0 && <span className="chat-projects-count">+{extras.length}</span>}
        <ChevronDownIcon />
      </button>
      <span className="chat-dock-sep" aria-hidden="true" />
      {at && (
        <ContextMenu at={at} above trigger={button.current} label="会话的项目" onClose={close}>
          <div className="chat-picker-heading">主项目 · 会话开始后固定</div>
          <div className="menu-item chat-projects-item chat-projects-primary" title={primary}>
            <FolderIcon />
            <span className="menu-item-name">{projectName(primary)}</span>
            <span className="menu-item-path mono">{primary}</span>
          </div>
          <div className="menu-separator" role="separator" />
          <div className="chat-picker-heading">额外项目</div>
          {extras.map((extra) => (
            <button
              key={extra}
              type="button"
              role="menuitemcheckbox"
              aria-checked="true"
              className="menu-item chat-projects-item"
              title={note ?? `${extra}\n点一下移除`}
              disabled={note !== null}
              onClick={() => void apply(extras.filter((each) => each !== extra))}
            >
              <FolderIcon />
              <span className="menu-item-name">{projectName(extra)}</span>
              <span className="menu-check"><CheckIcon /></span>
            </button>
          ))}
          {note === null && recent.map((each) => (
            <button
              key={each}
              type="button"
              role="menuitemcheckbox"
              aria-checked="false"
              className="menu-item chat-projects-item"
              title={each}
              disabled={full}
              onClick={() => void apply([...extras, each])}
            >
              <FolderIcon />
              <span className="menu-item-name">{projectName(each)}</span>
              <span className="menu-item-path mono">{each}</span>
            </button>
          ))}
          {note === null && canPickFolder() && (
            <>
              <div className="menu-separator" role="separator" />
              <button type="button" role="menuitem" className="menu-item" disabled={full} onClick={() => void browse()}>
                选择文件夹…
              </button>
            </>
          )}
          {note === null && extras.length === 0 && recent.length === 0 && !canPickFolder() && <p className="menu-note">没有最近用过的项目</p>}
          {footer && <p className="menu-note">{footer}</p>}
        </ContextMenu>
      )}
    </>
  )
}
