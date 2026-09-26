import { useCallback, useEffect, useState } from 'react'
import type { ProjectHead } from '@kando/protocol'
import { useCore } from '../core-store'
import { Popover } from './Popover'
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
  if (!head.branch) return '不是 git 仓库'
  return head.detached ? `${head.branch}（分离 HEAD）` : head.branch
}

// Each line is left out when an older core did not send its field.
function statusLines(head: ProjectHead): string[] {
  const lines: string[] = []
  if (head.changes !== undefined) lines.push(head.changes === 0 ? '没有未提交的改动' : `${head.changes} 个未提交的改动`)
  if (head.upstream === null && !head.detached) lines.push('没有跟踪远程分支')
  if (head.upstream) {
    const ahead = head.ahead ?? 0
    const behind = head.behind ?? 0
    const counts = [ahead > 0 && `领先 ${ahead} 个提交`, behind > 0 && `落后 ${behind} 个提交`].filter(Boolean)
    lines.push(`${head.upstream}：${counts.length > 0 ? counts.join('，') : '没有差异'}`)
  }
  return lines
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
      className="link-button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? '已复制' : '复制'}
    </button>
  )
}

// Every project's branch, uncommitted changes and distance from its upstream.
export function BranchStatusDetails({ heads }: { heads: readonly ProjectHead[] }) {
  return (
    <div className="branch-status">
      {heads.map((each) => (
        <section key={each.path} className="branch-status-project" aria-label={projectName(each.path)}>
          {heads.length > 1 && <div className="branch-status-name">{projectName(each.path)}</div>}
          <div className="branch-status-head">
            <span className="mono">{headLabel(each)}</span>
            {each.branch && <CopyButton text={each.branch} />}
          </div>
          {each.branch && statusLines(each).map((line) => <div key={line} className="muted">{line}</div>)}
        </section>
      ))}
      {heads.some((each) => each.upstream) && <p className="branch-status-note">领先和落后按上次 fetch 到的远程计算。</p>}
    </div>
  )
}

// The chip shows the first project that has a branch: a conversation's working directory, or a
// task's first worktree. The panel lists every project.
export function BranchStatus({ target, updatedAt }: { target: BranchTarget; updatedAt: number }) {
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const heads = useProjectHeads(target, updatedAt, opened)
  const head = heads.find((each) => each.branch)
  if (!head?.branch) return null
  const dirty = heads.some((each) => (each.changes ?? 0) > 0)
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="project-branch branch-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${headLabel(head)}${dirty ? '，有未提交的改动' : ''}，查看 git 状态`}
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
          <BranchStatusDetails heads={heads} />
        </Popover>
      )}
    </span>
  )
}
