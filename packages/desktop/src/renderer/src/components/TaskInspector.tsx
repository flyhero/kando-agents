import { useEffect, useState } from 'react'
import { RpcError, type ChangedFile, type FileDiff, type RepoChanges, type Task } from '@kando/protocol'
import { setInspectorOpen, useCore } from '../core-store'
import { BranchStatusDetails, useProjectHeads } from './BranchStatus'
import { ArrowLeftIcon, CloseIcon, RefreshIcon } from './icons'
import { PanelSeparator } from './PanelSeparator'
import { projectName } from './ProjectPicker'

type Tab = 'changes' | 'branch'

const KIND: Record<ChangedFile['kind'], { mark: string; text: string }> = {
  added: { mark: 'A', text: '新增' },
  modified: { mark: 'M', text: '修改' },
  deleted: { mark: 'D', text: '删除' },
  renamed: { mark: 'R', text: '重命名' },
  untracked: { mark: 'U', text: '新文件，还没加入 git' }
}

// Read again whenever the task changes (every agent turn and exit), the window regains focus,
// or the user refreshes. An older core without the method has nothing to show.
function useTaskChanges(taskId: string, updatedAt: number, refreshCount: number): RepoChanges[] | null {
  const rpc = useCore((state) => state.rpc)
  const [changes, setChanges] = useState<{ taskId: string; changes: RepoChanges[] } | null>(null)
  const [focusCount, setFocusCount] = useState(0)
  useEffect(() => {
    const onFocus = () => setFocusCount((count) => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('tasks.changes', { id: taskId })
      .catch(() => [])
      .then((found) => {
        if (current) setChanges({ taskId, changes: found })
      })
    return () => {
      current = false
    }
  }, [rpc, taskId, updatedAt, focusCount, refreshCount])
  return changes?.taskId === taskId ? changes.changes : null
}

function counts(file: ChangedFile): string {
  if (file.additions === null || file.deletions === null) return file.kind === 'untracked' ? '新文件' : '二进制'
  return `+${file.additions} −${file.deletions}`
}

function summary(repo: RepoChanges): string {
  const added = repo.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const removed = repo.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const commits = repo.commits.length >= 50 ? '至少 50 个提交' : `${repo.commits.length} 个提交`
  return `从 ${repo.base} 起 · ${commits} · ${repo.files.length} 个文件 · +${added} −${removed}`
}

function ChangeList({ changes, onOpen }: { changes: RepoChanges[] | null; onOpen: (repo: string, file: string) => void }) {
  if (changes === null) return <p className="inspector-empty muted">正在读取改动…</p>
  const compared = changes.filter((repo) => repo.base)
  if (compared.length === 0) return <p className="inspector-empty muted">任务还没有 worktree，执行过之后这里会列出 agent 的改动。</p>
  return (
    <>
      {compared.map((repo) => (
        <section key={repo.path} className="inspector-repo" aria-label={projectName(repo.path)}>
          {compared.length > 1 && <h3 className="inspector-repo-name">{projectName(repo.path)}</h3>}
          <p className="inspector-summary muted">{summary(repo)}</p>
          {repo.commits.length > 0 && (
            <details className="inspector-commits">
              <summary>提交记录</summary>
              <ul>
                {repo.commits.map((commit) => (
                  <li key={commit.sha}>
                    <span className="mono">{commit.sha}</span> {commit.subject}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {repo.files.length === 0 ? (
            <p className="muted">和起点相比没有改动。</p>
          ) : (
            <ul className="changed-files">
              {repo.files.map((file) => {
                const slash = file.path.lastIndexOf('/')
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="changed-file"
                      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      onClick={() => onOpen(repo.path, file.path)}
                    >
                      <span className="change-kind" data-kind={file.kind} aria-label={KIND[file.kind].text}>{KIND[file.kind].mark}</span>
                      <span className="changed-file-name">
                        {file.path.slice(slash + 1)}
                        {slash > 0 && <span className="muted"> {file.path.slice(0, slash)}</span>}
                      </span>
                      <span className="changed-file-counts mono">{counts(file)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (line.startsWith('@@')) return 'diff-hunk'
  return /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line) ? 'diff-meta' : 'diff-context'
}

function FileDiffView({ taskId, repo, file, refreshCount, onBack }: {
  taskId: string
  repo: string
  file: string
  refreshCount: number
  onBack: () => void
}) {
  const rpc = useCore((state) => state.rpc)
  const key = `${repo}\0${file}\0${refreshCount}`
  const [result, setResult] = useState<{ key: string; diff: FileDiff | null; gone: boolean } | null>(null)
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('tasks.diff', { id: taskId, repo, file }).then(
      (diff) => current && setResult({ key, diff, gone: false }),
      (error: unknown) => current && setResult({ key, diff: null, gone: error instanceof RpcError && error.reason === 'file-not-changed' })
    )
    return () => {
      current = false
    }
  }, [rpc, taskId, repo, file, key])
  const shown = result?.key === key ? result : null
  return (
    <div className="file-diff">
      <div className="file-diff-header">
        <button type="button" className="tool-button" aria-label="返回文件列表" data-tooltip="返回文件列表" onClick={onBack}>
          <ArrowLeftIcon />
        </button>
        <span className="mono file-diff-path" title={file}>{file}</span>
      </div>
      {!shown ? (
        <p className="inspector-empty muted">正在读取 diff…</p>
      ) : !shown.diff ? (
        <p className="inspector-empty muted">{shown.gone ? '这个文件已经不在改动里了，可能已经被还原。' : '读取 diff 失败。'}</p>
      ) : (
        <>
          <pre className="diff-view">
            {shown.diff.diff.split('\n').map((line, index) => (
              <div key={index} className={lineClass(line)}>{line || ' '}</div>
            ))}
          </pre>
          {shown.diff.truncated && <p className="inspector-empty muted">diff 太长，只显示了前 256KB。</p>}
        </>
      )}
    </div>
  )
}

// Beside the terminal: what the agent changed, to judge a result under review before accepting it.
export function TaskInspector({ task, widthRatio, onWidthRatioChange }: {
  task: Task
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
}) {
  const [tab, setTab] = useState<Tab>('changes')
  const [refreshCount, setRefreshCount] = useState(0)
  const [selected, setSelected] = useState<{ repo: string; file: string } | null>(null)
  const changes = useTaskChanges(task.id, task.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'task', id: task.id }, task.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, repo) => sum + repo.files.length, 0) ?? 0
  return (
    <>
      <PanelSeparator panelName="检查器" ratio={widthRatio} onRatioChange={onWidthRatioChange} />
      <aside
        className="side-panel inspector-panel"
        aria-label="任务检查器"
        style={{ flexBasis: `calc((100% - var(--side-panel-separator-size)) * ${widthRatio})` }}
      >
        <header className="inspector-header">
          <div className="inspector-tabs" role="tablist" aria-label="检查器">
            <button type="button" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>
              变更{fileCount > 0 && <span className="count">{fileCount}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'branch'} onClick={() => setTab('branch')}>
              分支
            </button>
          </div>
          <button type="button" className="tool-button inspector-refresh" aria-label="刷新" data-tooltip="刷新" onClick={() => setRefreshCount((count) => count + 1)}>
            <RefreshIcon />
          </button>
          <button type="button" className="tool-button" aria-label="收起检查器" data-tooltip="收起" onClick={() => setInspectorOpen(false)}>
            <CloseIcon />
          </button>
        </header>
        <div className="inspector-body" role="tabpanel">
          {tab === 'branch' ? (
            heads.some((head) => head.branch) ? <BranchStatusDetails heads={heads} /> : <p className="inspector-empty muted">任务还没有 worktree，也就没有分支。</p>
          ) : selected ? (
            <FileDiffView taskId={task.id} repo={selected.repo} file={selected.file} refreshCount={refreshCount} onBack={() => setSelected(null)} />
          ) : (
            <ChangeList changes={changes} onOpen={(repo, file) => setSelected({ repo, file })} />
          )}
        </div>
      </aside>
    </>
  )
}
