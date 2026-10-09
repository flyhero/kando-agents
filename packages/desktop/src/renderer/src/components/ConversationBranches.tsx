import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { checkSwitchBranch, type CommitPushResult, type CommitResult, type Conversation, type ProjectBranches, type ProjectHead, type PushResult } from '@kando/protocol'
import { perform, useCore } from '../core-store'
import { reasonText } from '../labels'
import { shortRef } from '../task-starts'
import { BranchStatusDetails } from './BranchStatus'
import { ArrowUpIcon, BranchIcon, CheckIcon, CommitIcon, PlusIcon } from './icons'
import { hasPrimaryModifier, PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { useOccludesBrowser } from '../browser-occlusion'

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

// The agent hears of the switch with the next message.
function switchedNote(branch: string): string {
  return `已切到 ${branch}，下一条消息会告诉 Agent。`
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

// The message gets room for a subject and a body. With the steps on their own, it can be kept
// local; ⌘Enter commits and pushes, as the main button does.
function CommitForm({ title, steps, busy, onCommit }: { title: string; steps: boolean; busy: boolean; onCommit: (message: string, push: boolean) => void }) {
  const [message, setMessage] = useState(title)
  const submit = (push: boolean) => {
    if (message.trim() && !busy) onCommit(message.trim(), push)
  }
  return (
    <div className="branch-action branch-commit">
      <textarea
        className="input branch-commit-message"
        autoFocus
        rows={6}
        value={message}
        maxLength={10_000}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hasPrimaryModifier(event) && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit(true)
          }
        }}
        placeholder="提交信息：第一行是标题，空一行再写详细说明"
        aria-label="提交信息"
      />
      <p className="branch-action-note">提交这个仓库里的全部改动{steps ? '；Commit & Push 再接着推送当前分支' : '，并推送当前分支'}，没有 upstream 时推到 origin 并跟踪它。</p>
      <div className="branch-commit-buttons">
        {steps && <button type="button" className="button" disabled={!message.trim() || busy} onClick={() => submit(false)}>Commit</button>}
        <button type="button" className="button primary" disabled={!message.trim() || busy} title={`${PRIMARY_KEY_LABEL}Enter`} onClick={() => submit(true)}>Commit &amp; Push</button>
      </div>
    </div>
  )
}

function PushForm({ head, busy, onPush }: { head: ProjectHead; busy: boolean; onPush: () => void }) {
  const what = head.upstream
    ? `把 ${head.branch} 上的 ${head.ahead ?? 0} 个提交推送到 ${head.upstream}。`
    : `${head.branch} 还没有 upstream，会推送到 origin 并跟踪它。`
  return (
    <div className="branch-action branch-commit">
      <p className="branch-push-what">{what}</p>
      {(head.changes ?? 0) > 0 && <p className="branch-action-note" data-warn>还有 {head.changes} 个未提交的改动，不会被推送。</p>}
      <div className="branch-commit-buttons">
        <button type="button" className="button primary" autoFocus disabled={busy} onClick={onPush}>Push</button>
      </div>
    </div>
  )
}

type BranchAction = 'switch' | 'create' | 'commit' | 'push'

const ACTION_TITLE: Record<BranchAction, string> = { switch: '切换分支', create: '新建分支', commit: 'Commit', push: 'Push' }

// One branch action in a dialog of its own, over the popover. It stays inside the popover's DOM, so
// pressing in it is not a click outside, and keeps Escape to itself, so the popover stays open
// under it and shows how the action went.
function BranchActionDialog({ action, head, onClose, children }: { action: BranchAction; head: ProjectHead; onClose: () => void; children: ReactNode }) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    // showModal takes the focus to the first button, the close; the action's field wants it.
    element?.querySelector<HTMLElement>('input, textarea, .button.primary')?.focus()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="modal branch-dialog"
      aria-label={`${ACTION_TITLE[action]} · ${folderName(head.path)}`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
      // The backdrop is the dialog itself; its content sits in .modal-body.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-body">
        <header className="modal-header">
          <div>
            <h2>{ACTION_TITLE[action]}</h2>
            <p className="branch-dialog-where muted">{folderName(head.path)}{head.branch ? ` · 当前在 ${head.branch}` : ''}</p>
          </div>
          <button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {children}
      </div>
    </dialog>
  )
}

function ProjectActions({ conversation, head, option, onChanged }: {
  conversation: Conversation
  head: ProjectHead
  option: ProjectBranches | undefined
  onChanged: (note: string) => void
}) {
  const commitPush = useCore((s) => s.rpc?.features.includes('conversation-commit-push') ?? false)
  // An older core does both in one; the steps on their own come with conversation-commit-steps.
  const steps = useCore((s) => s.rpc?.features.includes('conversation-commit-steps') ?? false)
  const [open, setOpen] = useState<BranchAction | null>(null)
  const [busy, setBusy] = useState(false)
  if (!option?.git) return null
  const blocker = checkSwitchBranch(conversation)
  const done = <T,>(note: (result: T) => string) => (result: T | null) => {
    setBusy(false)
    if (result) {
      setOpen(null)
      onChanged(note(result))
    }
  }
  const run = async (call: Parameters<typeof perform>[0], branch: string) => {
    setBusy(true)
    done(() => switchedNote(branch))(await perform(call))
  }
  const project = { id: conversation.id, project: head.path }
  const commit = async (message: string, push: boolean) => {
    setBusy(true)
    if (push || !steps) {
      done<CommitPushResult>((result) => `已提交 ${result.commit} 并推送到 ${result.upstream}。`)(await perform((rpc) => rpc.call('conversations.commitPush', { ...project, message })))
    } else {
      done<CommitResult>((result) => `已提交 ${result.commit}，还没推送。`)(await perform((rpc) => rpc.call('conversations.commit', { ...project, message })))
    }
  }
  const push = async () => {
    setBusy(true)
    done<PushResult>((result) => `已把 ${result.branch} 推送到 ${result.upstream}。`)(await perform((rpc) => rpc.call('conversations.push', project)))
  }
  const hint = blocker ? reasonText(blocker, blocker) : undefined
  const commitHint = hint ?? (!head.branch ? '当前没有分支' : head.changes === 0 ? '没有可以提交的改动' : undefined)
  // Nothing to push: a tracked branch with no commit past its upstream.
  const pushHint = hint ?? (!head.branch ? '当前没有分支' : head.upstream && (head.ahead ?? 0) === 0 ? '没有要推送的提交' : undefined)
  const canCommit = !blocker && Boolean(head.branch) && (head.changes ?? 0) > 0
  const canPush = !blocker && Boolean(head.branch) && !(head.upstream && (head.ahead ?? 0) === 0)
  const button = (action: BranchAction, enabled: boolean, title: string | undefined, content: ReactNode, primary = false) => (
    <button
      type="button"
      className="branch-action-button"
      data-primary={primary || undefined}
      aria-haspopup="dialog"
      aria-expanded={open === action}
      disabled={busy || !enabled}
      title={title}
      onClick={() => setOpen(action)}
    >
      {content}
    </button>
  )
  return (
    <>
      <div className="branch-actions">
        {button('switch', blocker === null, hint, <><BranchIcon />切换</>)}
        {button('create', blocker === null, hint, <><PlusIcon />新建</>)}
        {commitPush && button('commit', canCommit, commitHint, <><CommitIcon />{steps ? 'Commit' : 'Commit & Push'}</>, canCommit)}
        {commitPush && steps && button('push', canPush, pushHint, <><ArrowUpIcon />Push</>, !canCommit && canPush && (head.ahead ?? 0) > 0)}
        {blocker && <span className="branch-actions-blocked">{hint}</span>}
      </div>
      {open && (
        <BranchActionDialog action={open} head={head} onClose={() => setOpen(null)}>
          {open === 'switch' && (
            <SwitchList option={option} onPick={(ref) => void run((rpc) => rpc.call('conversations.switchBranch', { ...project, ref }), localName(ref))} />
          )}
          {open === 'create' && <CreateForm onCreate={(name) => void run((rpc) => rpc.call('conversations.createBranch', { ...project, name }), name)} />}
          {open === 'commit' && <CommitForm title={conversation.title} steps={steps} busy={busy} onCommit={(message, alsoPush) => void commit(message, alsoPush)} />}
          {open === 'push' && <PushForm head={head} busy={busy} onPush={() => void push()} />}
        </BranchActionDialog>
      )}
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
