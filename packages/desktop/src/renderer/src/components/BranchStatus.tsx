import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ProjectHead } from '@kando/protocol'
import { useCore } from '../core-store'
import { ConversationBranches } from './ConversationBranches'
import { Popover } from './Popover'
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, CheckIcon, CopyIcon, FolderIcon } from './icons'
import { projectName } from './ProjectPicker'

export type BranchTarget = { kind: 'task' | 'conversation'; id: string }

// Asked again on open, when the window regains focus, whenever the task or conversation changes
// (every agent turn and exit) and when the panel opens. An older core without the method shows nothing.
export function useProjectHeads(target: BranchTarget, updatedAt: number, opened: number): ProjectHead[] {
  const rpc = useCore((state) => state.rpc)
  const key = `${target.kind}:${target.id}`
  const [heads, setHeads] = useState<{ key: string; heads: ProjectHead[] }>({ key: '', heads: [] })
  const [focusCount, setFocusCount] = useState(0)
  useEffect(() => {
    const onFocus = () => setFocusCount((count) => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => {
    if (!rpc) return
    let current = true
    const { kind, id } = target
    const request = kind === 'task' ? rpc.call('tasks.branches', { id }) : rpc.call('conversations.branches', { id })
    void request
      .catch(() => [])
      .then((found) => {
        if (current) setHeads({ key, heads: found })
      })
    return () => {
      current = false
    }
  }, [rpc, key, updatedAt, focusCount, opened])
  return heads.key === key ? heads.heads : []
}

function headLabel(head: ProjectHead): string {
  if (!head.branch) return '无 Git 分支'
  return head.detached ? `${head.branch}（分离 HEAD）` : head.branch
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="icon-button branch-status-copy"
      aria-label={copied ? '已复制' : '复制分支名'}
      title={copied ? '已复制' : '复制分支名'}
      data-copied={copied || undefined}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

// The checked-out branch as a chip like the header's; a folder outside git gets plain words.
export function BranchChip({ branch, detached = false }: { branch: string | null; detached?: boolean }) {
  if (!branch) return <span className="branch-status-nogit">无 Git</span>
  return (
    <span className="branch-status-branch" title={detached ? `${branch}（分离 HEAD）` : branch}>
      <BranchIcon />
      <span className="mono">{branch}</span>
      {detached && <span className="branch-status-detached">分离</span>}
    </span>
  )
}

// A project's name row: its folder, the accent's when it is the primary, and its branch.
export function ProjectRow({ path, branch, detached, children }: { path: string; branch: string | null; detached?: boolean; children?: ReactNode }) {
  return (
    <div className="branch-status-row">
      <span className="branch-status-name" title={path}>
        <FolderIcon />
        <span>{projectName(path)}</span>
      </span>
      <BranchChip branch={branch} detached={detached} />
      {children}
    </div>
  )
}

// The headings the projects list under, in the status panel and the inspectors alike.
export function ProjectGroups<T extends { path: string }>({ items, children }: { items: readonly T[]; children: (item: T, primary: boolean) => ReactNode }) {
  const [primary, ...extras] = items
  if (!primary) return null
  return (
    <>
      <div className="branch-status-heading">主项目</div>
      {children(primary, true)}
      {extras.length > 0 && (
        <div className="branch-status-heading">
          附加项目<span className="branch-status-heading-count">{extras.length}</span>
        </div>
      )}
      {extras.map((each) => children(each, false))}
    </>
  )
}

// One line: the working tree (dot + count), the distance from the upstream, and its name. Each
// part is left out when an older core did not send its field.
function StatusLine({ head }: { head: ProjectHead }) {
  const parts: ReactNode[] = []
  if (head.changes !== undefined) {
    parts.push(
      <span key="changes" className="branch-status-stat" data-dirty={head.changes > 0 || undefined}>
        <i className="branch-status-dot" aria-hidden="true" />
        {head.changes === 0 ? '干净' : `${head.changes} 个改动`}
      </span>
    )
  }
  if (head.upstream === null && !head.detached) parts.push(<span key="track" className="branch-status-stat">没有跟踪远程分支</span>)
  if (head.upstream) {
    const ahead = head.ahead ?? 0
    const behind = head.behind ?? 0
    if (ahead > 0) parts.push(<span key="ahead" className="branch-status-stat" aria-label={`领先 ${ahead} 个提交`}><ArrowUpIcon />{ahead}</span>)
    if (behind > 0) parts.push(<span key="behind" className="branch-status-stat" aria-label={`落后 ${behind} 个提交`}><ArrowDownIcon />{behind}</span>)
    if (ahead === 0 && behind === 0) parts.push(<span key="synced" className="branch-status-stat">已同步</span>)
    parts.push(<span key="upstream" className="branch-status-upstream mono">{head.upstream}</span>)
  }
  if (parts.length === 0) return null
  return <div className="branch-status-line">{parts}</div>
}

function Project({ head, primary, actions }: { head: ProjectHead; primary: boolean; actions?: (head: ProjectHead) => ReactNode }) {
  return (
    <section className="branch-status-project" data-primary={primary || undefined} aria-label={projectName(head.path)}>
      <ProjectRow path={head.path} branch={head.branch} detached={head.detached}>
        {head.branch && <CopyButton text={head.branch} />}
      </ProjectRow>
      {head.branch && <StatusLine head={head} />}
      {head.branch && actions?.(head)}
    </section>
  )
}

// Every project's branch, uncommitted changes and distance from its upstream, the primary first
// under its own heading; `actions` adds what can be done in each.
export function BranchStatusDetails({ heads, actions }: { heads: readonly ProjectHead[]; actions?: (head: ProjectHead) => ReactNode }) {
  if (heads.length === 0) return null
  return (
    <div className="branch-status">
      <ProjectGroups items={heads}>
        {(head, primary) => <Project key={head.path} head={head} primary={primary} actions={actions} />}
      </ProjectGroups>
      {heads.some((each) => each.upstream) && <p className="branch-status-note">领先 / 落后按上次 fetch 到的远程计算</p>}
    </div>
  )
}

// Even a primary folder without Git must leave the other repos' status accessible.
export function BranchStatus({ target, updatedAt }: { target: BranchTarget; updatedAt: number }) {
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const heads = useProjectHeads(target, updatedAt, opened)
  const head = heads[0]
  if (!head) return null
  const dirty = heads.some((each) => (each.changes ?? 0) > 0)
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="project-branch branch-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`主项目 ${projectName(head.path)}：${headLabel(head)}${dirty ? '，有未提交的改动' : ''}，查看 git 状态`}
        data-dirty={dirty || undefined}
        onClick={() => {
          if (!open) setOpened((count) => count + 1)
          setOpen((current) => !current)
        }}
      >
        {headLabel(head)}
      </button>
      {open && (
        <Popover label="git 状态" onClose={close}>
          {target.kind === 'conversation'
            ? <ConversationBranches id={target.id} heads={heads} onChanged={() => setOpened((count) => count + 1)} />
            : <BranchStatusDetails heads={heads} />}
        </Popover>
      )}
    </span>
  )
}
