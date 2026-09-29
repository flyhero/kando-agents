import { useEffect, useState, type KeyboardEvent } from 'react'
import { checkSwitchBranch, type Conversation, type ProjectBranches, type ProjectHead } from '@kando/protocol'
import { perform, useCore } from '../core-store'
import { reasonText } from '../labels'
import { shortRef } from '../task-starts'
import { BranchStatusDetails } from './BranchStatus'
import { CheckIcon } from './icons'

// A conversation works in the user's own checkout: switching changes it for everything in the folder.
function useBranchOptions(id: string, version: number): readonly ProjectBranches[] {
  const rpc = useCore((s) => s.rpc)
  const [options, setOptions] = useState<readonly ProjectBranches[]>([])
  useEffect(() => {
    if (!rpc?.features.includes('conversation-branches')) return
    let live = true
    void rpc.call('conversations.branchOptions', { id }).then((found) => {
      if (live) setOptions(found)
    }, () => {})
    return () => {
      live = false
    }
  }, [rpc, id, version])
  return options
}

// The local branch a switch to `ref` leaves checked out: a remote one goes by its own name.
function localName(ref: string): string {
  return ref.startsWith('refs/remotes/') ? shortRef(ref).split('/').slice(1).join('/') : shortRef(ref)
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder
}

// Where the switch leaves the agent: a chat one hears of it with the next message, a terminal one
// only from the user.
function switchedNote(conversation: Conversation, branch: string): string {
  return conversation.mode === 'chat'
    ? `已切到 ${branch}，下一条消息会告诉 agent。`
    : `已切到 ${branch}。终端里的 agent 不会自动知道，继续时记得告诉它。`
}

function SwitchList({ option, onPick }: { option: ProjectBranches; onPick: (ref: string) => void }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const refs = needle ? option.refs.filter((ref) => shortRef(ref).toLowerCase().includes(needle)) : option.refs
  const current = option.branch ? `refs/heads/${option.branch}` : null
  const pickable = (ref: string) => ref !== current && !option.elsewhere[ref]
  const onKey = (event: KeyboardEvent) => {
    const first = refs.find(pickable)
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      onPick(first)
    }
  }
  if (option.changes > 0) return <p className="branch-action-note" data-warn>有 {option.changes} 个未提交的改动，先提交或暂存再切换。</p>
  return (
    <div className="branch-action">
      {option.sharedWith.length > 0 && (
        <p className="branch-action-note" data-warn>
          {option.sharedWith.map((title) => `会话「${title}」`).join('、')}也在用这个目录，切换后它们看到的文件也会变。
        </p>
      )}
      <input className="input menu-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey} placeholder="搜索分支，回车切到第一个" aria-label="搜索分支" />
      <ul className="menu-list branch-action-list">
        {refs.map((ref) => {
          const holder = option.elsewhere[ref]
          return (
            <li key={ref} className="menu-row">
              <button type="button" className="menu-item" disabled={!pickable(ref)} title={holder ? `已在 ${holder} 里检出` : undefined} onClick={() => onPick(ref)}>
                <span className="menu-item-title mono">{shortRef(ref)}</span>
                {holder && <span className="menu-item-path">在 {folderName(holder)} 里</span>}
                {ref === current && <span className="menu-check"><CheckIcon /></span>}
              </button>
            </li>
          )
        })}
      </ul>
      {refs.length === 0 && <p className="branch-action-note">没有匹配的分支</p>}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    if (name.trim()) onCreate(name.trim())
  }
  return (
    <div className="branch-action branch-action-create">
      <input
        className="input"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
        placeholder="新分支名，如 fix/login"
        aria-label="新分支名"
      />
      <button type="button" className="button" disabled={!name.trim()} onClick={submit}>创建并切换</button>
      <p className="branch-action-note">从当前提交拉出，未提交的改动会一起带过去。</p>
    </div>
  )
}

function ProjectActions({ conversation, head, option, onChanged }: {
  conversation: Conversation
  head: ProjectHead
  option: ProjectBranches | undefined
  onChanged: (note: string) => void
}) {
  const [open, setOpen] = useState<'switch' | 'create' | null>(null)
  const [busy, setBusy] = useState(false)
  if (!option?.git) return null
  const blocker = checkSwitchBranch(conversation)
  const run = async (call: Parameters<typeof perform>[0], branch: string) => {
    setBusy(true)
    const done = await perform(call)
    setBusy(false)
    if (done) {
      setOpen(null)
      onChanged(switchedNote(conversation, branch))
    }
  }
  const toggle = (next: 'switch' | 'create') => setOpen(open === next ? null : next)
  const hint = blocker ? reasonText(blocker, blocker) : undefined
  return (
    <>
      <div className="branch-actions">
        <button type="button" className="link-button" aria-expanded={open === 'switch'} disabled={busy || blocker !== null} title={hint} onClick={() => toggle('switch')}>切换分支</button>
        <button type="button" className="link-button" aria-expanded={open === 'create'} disabled={busy || blocker !== null} title={hint} onClick={() => toggle('create')}>新建分支</button>
        {blocker && <span className="muted">{hint}</span>}
      </div>
      {open === 'switch' && (
        <SwitchList option={option} onPick={(ref) => void run((rpc) => rpc.call('conversations.switchBranch', { id: conversation.id, project: head.path, ref }), localName(ref))} />
      )}
      {open === 'create' && <CreateForm onCreate={(name) => void run((rpc) => rpc.call('conversations.createBranch', { id: conversation.id, project: head.path, name }), name)} />}
    </>
  )
}

// The branch popover of a conversation: each project's state, and switching it or starting a
// branch there, while no agent works in the folder.
export function ConversationBranches({ id, heads, onChanged }: { id: string; heads: readonly ProjectHead[]; onChanged: () => void }) {
  const conversation = useCore((s) => s.conversations[id])
  const [version, setVersion] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const options = useBranchOptions(id, version)
  if (!conversation) return <BranchStatusDetails heads={heads} />
  const changed = (text: string) => {
    setNote(text)
    setVersion((current) => current + 1)
    onChanged()
  }
  return (
    <>
      <BranchStatusDetails
        heads={heads}
        actions={(head) => (
          <ProjectActions key={head.path} conversation={conversation} head={head} option={options.find((option) => option.path === head.path)} onChanged={changed} />
        )}
      />
      {note && <p className="branch-status-note branch-action-done" role="status">{note}</p>}
    </>
  )
}

