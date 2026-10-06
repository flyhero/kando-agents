import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import type { ProjectBranches } from '@kando/protocol'
import { useCore } from '../core-store'
import { shortRef } from '../task-starts'
import { BranchIcon, CheckIcon, ChevronDownIcon } from './icons'
import { Popover } from './Popover'
import { projectName } from './ProjectPicker'

// The primary project's branches, asked of core when it is picked and again each time the list opens.
export function useProjectBranches(project: string | null): { options: ProjectBranches | null; refresh: () => void } {
  const rpc = useCore((s) => s.rpc)
  const [options, setOptions] = useState<ProjectBranches | null>(null)
  const refresh = useCallback(() => {
    if (!rpc || !project) return
    void rpc.call('projects.branches', { path: project }).then((next) => setOptions(next.path === project ? next : null), () => setOptions(null))
  }, [rpc, project])
  useEffect(() => {
    setOptions(null)
    refresh()
  }, [refresh])
  return { options, refresh }
}

// Which branch a new conversation starts on, beside its primary project. With a worktree, the
// branch its own is made from; without, the one the project is switched to before the agent
// starts. picked: a full ref, or null for the branch the project has checked out.
export function DraftBranchPicker({ options, picked, worktree, locked, onOpen, onPick }: {
  options: ProjectBranches
  picked: string | null
  worktree: boolean
  locked: boolean
  onOpen: () => void
  onPick: (ref: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const close = useCallback(() => setOpen(false), [])
  const current = options.branch ? `refs/heads/${options.branch}` : null
  const chosen = picked ?? current
  const needle = query.trim().toLowerCase()
  // Local branches only, as Claude's own app lists them: a remote one is fetched and checked out
  // as a local branch first.
  const local = options.refs.filter((ref) => ref.startsWith('refs/heads/'))
  const refs = needle ? local.filter((ref) => shortRef(ref).toLowerCase().includes(needle)) : local
  // git checks a branch out in one worktree at a time; as where a new one starts, any will do.
  const pickable = (ref: string) => worktree || !options.elsewhere[ref] || ref === current
  const pick = (ref: string) => {
    onPick(ref === current ? null : ref)
    close()
  }
  const onKey = (event: KeyboardEvent) => {
    const first = refs.find(pickable)
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      pick(first)
    }
  }
  const name = chosen ? shortRef(chosen) : 'HEAD'
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="chat-draft-branch"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={locked}
        data-tooltip={worktree ? '新 worktree 从这个分支拉出' : '在这个分支上工作；选别的分支，发送时会把项目目录切过去'}
        data-tooltip-side="top"
        onClick={() => {
          if (!open) {
            setQuery('')
            onOpen()
          }
          setOpen(!open)
        }}
      >
        <BranchIcon />
        {worktree && <span className="chat-draft-branch-from">从</span>}
        <span className="chat-draft-branch-name mono">{name}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <Popover label={worktree ? '选择起点分支' : '选择分支'} onClose={close}>
          <p className="menu-label">{worktree ? `${projectName(options.path)} 的新 worktree 从哪个分支拉出` : `在 ${projectName(options.path)} 的哪个分支上工作`}</p>
          <input className="input menu-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKey} placeholder="搜索分支，回车选第一个" aria-label="搜索分支" />
          <ul className="menu-list branch-action-list">
            {refs.map((ref) => {
              const holder = options.elsewhere[ref]
              return (
                <li key={ref} className="menu-row">
                  <button type="button" className="menu-item" disabled={!pickable(ref)} title={holder && !worktree ? `已在 ${holder} 里检出` : undefined} onClick={() => pick(ref)}>
                    <span className="menu-item-title mono">{shortRef(ref)}</span>
                    {ref === current && <span className="menu-item-path">当前</span>}
                    {holder && !worktree && <span className="menu-item-path">在 {projectName(holder)} 里</span>}
                    {ref === chosen && <span className="menu-check"><CheckIcon /></span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {refs.length === 0 && <p className="branch-action-note">没有匹配的分支</p>}
        </Popover>
      )}
    </span>
  )
}

// What a switch picked without a worktree will do to the project, and what may stop it.
export function switchNote(options: ProjectBranches, picked: string | null): { text: string; warn: boolean } | null {
  if (!picked) return null
  const project = projectName(options.path)
  if (options.changes > 0) return { text: `${project} 有 ${options.changes} 个未提交的改动，切不过去：先提交或暂存，或勾选新 worktree`, warn: true }
  const shared = options.sharedWith.length > 0 ? `；会话${options.sharedWith.map((title) => `「${title}」`).join('、')}也在用这个目录` : ''
  return { text: `发送时会把 ${project} 切到 ${shortRef(picked)}${shared}`, warn: true }
}
