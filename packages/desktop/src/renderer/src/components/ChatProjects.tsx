import { useRef, useState } from 'react'
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

function sameProjects(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((each) => b.includes(each))
}

// The dock header's first chip: where the conversation works. The primary is the cwd its session
// began in; the others come and go from the menu, which restarts an idle agent on its session.
// Ticks wait for the menu to close, so picking several restarts the agent once and the rows hold still.
export function ChatProjects({ conversation }: { conversation: Conversation }) {
  const supported = useCore((s) => s.rpc?.features.includes('conversation-projects') ?? false)
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const [recent, setRecent] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [ticked, setTicked] = useState<readonly string[]>([])
  // Mirrors `ticked` while the menu is open; null once applied, so a second close event can't apply twice.
  const pending = useRef<readonly string[] | null>(null)
  const [primary, ...extras] = conversation.projectPaths
  if (!primary) return null
  const note = blockerNote(conversation, supported)
  const full = 1 + ticked.length >= MAX_TASK_REPOS
  const choices = note ? extras : [...extras, ...recent.filter((each) => !conversation.projectPaths.includes(each))]
  const apply = async (next: readonly string[]) => {
    if (sameProjects(next, extras)) return
    setBusy(true)
    await perform((rpc) => rpc.call('conversations.setAdditionalProjects', { id: conversation.id, projectPaths: [...next] }))
    setBusy(false)
  }
  const tick = (next: readonly string[]) => {
    pending.current = next
    setTicked(next)
  }
  // Takes what is ticked so far, and leaves it unapplied.
  const dismiss = () => {
    const next = pending.current
    pending.current = null
    setAt(null)
    return next
  }
  const close = () => {
    const next = dismiss()
    if (next) void apply(next)
  }
  const open = async () => {
    const box = button.current?.getBoundingClientRect()
    if (!box) return
    tick(extras)
    setAt({ x: box.left, y: box.top })
    if (note) return
    const found = await perform((rpc) => rpc.call('projects.recent', {}))
    setRecent(found ?? [])
  }
  // The dialog takes the focus, which closes the menu anyway; its pick joins the ticks in one apply.
  const browse = async () => {
    const base = dismiss() ?? extras
    const picked = await pickFolder(parentDir(primary))
    await apply(picked && !base.includes(picked) ? [...base, picked] : base)
  }
  // The agent is given its directories at launch.
  const footer = note ?? (conversation.sessionId !== null ? '菜单关上后生效，Agent 会在同一个会话里重启，拿到新的目录' : null)
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
          {choices.map((each) => {
            const on = ticked.includes(each)
            return (
              <button
                key={each}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className="menu-item chat-projects-item"
                title={note ?? (on ? `${each}\n点一下移除` : each)}
                disabled={note !== null || busy || (!on && full)}
                onClick={() => tick(on ? ticked.filter((other) => other !== each) : [...ticked, each])}
              >
                <FolderIcon />
                <span className="menu-item-name">{projectName(each)}</span>
                <span className="menu-item-path mono">{each}</span>
                {on && <span className="menu-check"><CheckIcon /></span>}
              </button>
            )
          })}
          {note === null && canPickFolder() && (
            <>
              <div className="menu-separator" role="separator" />
              <button type="button" role="menuitem" className="menu-item" disabled={full || busy} onClick={() => void browse()}>
                选择文件夹…
              </button>
            </>
          )}
          {note === null && choices.length === 0 && !canPickFolder() && <p className="menu-note">没有最近用过的项目</p>}
          {footer && <p className="menu-note">{footer}</p>}
        </ContextMenu>
      )}
    </>
  )
}
