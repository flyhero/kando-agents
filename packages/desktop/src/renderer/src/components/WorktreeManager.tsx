import { useEffect, useMemo, useState } from 'react'
import { openTerminal, selectConversation, selectTask, setWorktreesOpen, showError, useCore } from '../core-store'
import { timeAgo } from '../conversation-state'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { reasonText, STATUS_LABEL } from '../labels'
import { formatBytes, groupWorktrees, worktreeRows, worktreeState, worktreeSummary, type WorktreeGroupId, type WorktreeRow } from '../worktree-groups'
import { cleanWorktrees, refreshWorktrees, useWorktrees } from '../worktree-store'
import { CloseIcon, FolderIcon, TerminalIcon } from './icons'
import { projectName } from './ProjectPicker'

const GROUP_TEXT: Record<WorktreeGroupId, { title: string; note: string }> = {
  cleanable: { title: '可以清理', note: '任务已完成或已废弃，没有未提交的改动' },
  orphaned: { title: '找不到任务或会话', note: '任务或会话删了，worktree 还在' },
  attention: { title: '需要你处理', note: '清理会丢东西，先在终端里提交、移走或丢弃' },
  active: { title: '进行中', note: '任务还没完成或会话还在，只看占用' }
}

const CLEAN_NOTE = '分支和提交都会保留，任务之后继续修改时会重建 worktree。被 .gitignore 忽略的文件（如 node_modules、.env）会一起删除。'

// Asks first, then says what was kept and why; what went needs no word.
export async function cleanWithConfirm(paths: readonly string[], subject: string): Promise<void> {
  if (paths.length === 0 || !window.confirm(`清理${subject}？\n\n${CLEAN_NOTE}`)) return
  const results = await cleanWorktrees(paths)
  const kept = results?.filter((result) => !result.removed) ?? []
  if (kept.length > 0) {
    const reasons = [...new Set(kept.map((result) => reasonText(result.reason ?? 'worktree-failed', result.reason ?? '')))]
    showError(`有 ${kept.length} 个 worktree 没有清理：${reasons.join('；')}`)
  }
}

function Row({ row, now, checked, onToggle }: { row: WorktreeRow; now: number; checked: boolean | null; onToggle: () => void }) {
  const { worktree, task, conversation } = row
  const state = worktreeState(row)
  const project = projectName(worktree.repo ?? worktree.path)
  return (
    <li className="worktree-row">
      <span className="worktree-check">
        {checked !== null && (
          <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`清理 ${task?.title ?? conversation?.title ?? worktree.path}`} />
        )}
      </span>
      <span className="worktree-main">
        <span className="worktree-title" title={worktree.path}>{task?.title ?? conversation?.title ?? (worktree.conversationId ? '会话' : '任务或会话已删除')}</span>
        <span className="worktree-meta">
          {[task && STATUS_LABEL[task.status], worktree.conversationId && '会话', timeAgo(worktree.touchedAt, now), project, worktree.planning && '规划副本'].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="worktree-branch mono" title={worktree.path}>{worktree.branch ?? '没有分支'}</span>
      <span className="worktree-state" data-warn={state.warn || undefined}>{state.text}</span>
      <span className="worktree-size">{worktree.size === null ? '…' : formatBytes(worktree.size)}</span>
      <span className="worktree-actions">
        {task && (
          <button type="button" className="button ghost worktree-open" onClick={() => selectTask(task.id)}>
            打开任务
          </button>
        )}
        {worktree.conversationId && (
          <button type="button" className="button ghost worktree-open" onClick={() => selectConversation(worktree.conversationId ?? null)}>
            打开会话
          </button>
        )}
        <button type="button" className="tool-button" aria-label="在终端里打开" data-tooltip="在终端里打开" onClick={() => void openTerminal(worktree.path)}>
          <TerminalIcon />
        </button>
        {canRevealFile() && (
          <button type="button" className="tool-button" aria-label="在文件管理器中显示" data-tooltip="在文件管理器中显示" onClick={() => void revealFile([worktree.path])}>
            <FolderIcon />
          </button>
        )}
      </span>
    </li>
  )
}

// Every worktree Kando laid out, by what can be done about each. Nothing goes without asking, and
// only what loses nothing can be picked.
export function WorktreeManager() {
  const list = useWorktrees((s) => s.list)
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const rows = useMemo(() => (list ? worktreeRows(list, tasks, conversations) : []), [list, tasks, conversations])
  const groups = groupWorktrees(rows)
  const summary = worktreeSummary(rows)
  // Unpicked paths; everything that can be cleaned starts picked.
  const [unpicked, setUnpicked] = useState<ReadonlySet<string>>(new Set())
  const [showActive, setShowActive] = useState(false)
  const [busy, setBusy] = useState(false)
  // An agent ending changes no task, so nothing else would say its worktree is free now.
  useEffect(() => refreshWorktrees(0), [])
  const picked = rows.filter((row) => row.blocker === null && !unpicked.has(row.worktree.path)).map((row) => row.worktree.path)
  const now = Date.now()
  const toggle = (worktreePath: string) =>
    setUnpicked((current) => {
      const next = new Set(current)
      if (!next.delete(worktreePath)) next.add(worktreePath)
      return next
    })
  const clean = async () => {
    setBusy(true)
    await cleanWithConfirm(picked, ` ${picked.length} 个 worktree`)
    setBusy(false)
  }

  return (
    <section className="worktrees-page" aria-label="Worktree">
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>Worktree</h2>
          <p className="muted">
            共 {summary.count} 个 · 占用 {formatBytes(summary.bytes)}{summary.counting ? '（还在统计）' : ''} · {summary.cleanable} 个可以清理
          </p>
          <p className="muted">清理只删 worktree 目录。{CLEAN_NOTE}</p>
        </div>
        <button type="button" className="button primary" disabled={busy || picked.length === 0} onClick={() => void clean()}>
          清理所选（{picked.length} 个）
        </button>
        <button type="button" className="tool-button" aria-label="关闭" data-tooltip="关闭" onClick={() => setWorktreesOpen(false)}>
          <CloseIcon />
        </button>
      </header>
      {list === null ? (
        <p className="worktrees-empty muted">正在读取…</p>
      ) : rows.length === 0 ? (
        <p className="worktrees-empty muted">没有 Kando 建的 worktree。</p>
      ) : (
        groups.map((group) => {
          const collapsed = group.id === 'active' && !showActive
          return (
            <section key={group.id} className="worktree-group" aria-label={GROUP_TEXT[group.id].title}>
              <h3 className="worktree-group-title">
                {GROUP_TEXT[group.id].title} · {group.rows.length}
                <span className="muted"> · {GROUP_TEXT[group.id].note}</span>
                {group.id === 'active' && (
                  <button type="button" className="link-button" aria-expanded={!collapsed} onClick={() => setShowActive(!showActive)}>
                    {collapsed ? '展开' : '收起'}
                  </button>
                )}
              </h3>
              {!collapsed && (
                <ul className="worktree-list">
                  {group.rows.map((row) => (
                    <Row
                      key={row.worktree.path}
                      row={row}
                      now={now}
                      checked={row.blocker === null ? !unpicked.has(row.worktree.path) : null}
                      onToggle={() => toggle(row.worktree.path)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </section>
  )
}
