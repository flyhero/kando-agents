import { useEffect, useState, type ReactNode } from 'react'
import { RpcError, type ChangedFile, type Commit, type FileDiff } from '@kando/protocol'
import { useCore } from '../core-store'
import type { BranchTarget } from './BranchStatus'
import { DiffLines } from './DiffLines'
import { ArrowLeftIcon, ChevronRightIcon, CloseIcon, RefreshIcon } from './icons'
import { PanelSeparator } from './PanelSeparator'

// The pieces both inspectors are built from: a task's, beside its terminal, and a conversation's.

const KIND: Record<ChangedFile['kind'], { mark: string; text: string }> = {
  added: { mark: 'A', text: '新增' },
  modified: { mark: 'M', text: '修改' },
  deleted: { mark: 'D', text: '删除' },
  renamed: { mark: 'R', text: '重命名' },
  untracked: { mark: 'U', text: '新文件，还没加入 git' }
}

// Bumps whenever the window regains focus: the user may have changed files meanwhile.
export function useFocusCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const onFocus = () => setCount((current) => current + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return count
}

// The files a task's worktrees or a conversation's projects have changed, whichever the target is;
// read again as updatedAt and refresh move, and when the window regains focus.
export function useChangedFiles(target: BranchTarget | null, updatedAt: number, refresh: number): ChangedFile[] | null {
  const rpc = useCore((state) => state.rpc)
  const focusCount = useFocusCount()
  const key = target ? `${target.kind}:${target.id}` : null
  const [files, setFiles] = useState<{ key: string; files: ChangedFile[] } | null>(null)
  useEffect(() => {
    if (!rpc || !target || !key) return
    let current = true
    const read = target.kind === 'task'
      ? rpc.call('tasks.changes', { id: target.id }).then((repos) => repos.flatMap((repo) => repo.files))
      : rpc.call('conversations.changes', { id: target.id }).then((folders) => folders.flatMap((folder) => folder.files))
    void read.catch(() => []).then((found) => {
      if (current) setFiles({ key, files: found })
    })
    return () => {
      current = false
    }
  }, [rpc, key, updatedAt, focusCount, refresh])
  return files?.key === key ? files.files : null
}

export type InspectorTab = 'changes' | 'branch' | 'plan'

const TAB_LABEL: Record<InspectorTab, string> = { changes: '变更', branch: '分支', plan: '计划' }
export const GIT_TABS: readonly InspectorTab[] = ['changes', 'branch']

export function InspectorPanel({ label, ratio, onRatioChange, tabs = GIT_TABS, tab, onTab, fileCount, onRefresh, onClose, children }: {
  label: string
  ratio: number
  onRatioChange: (ratio: number) => void
  tabs?: readonly InspectorTab[]
  tab: InspectorTab
  onTab: (tab: InspectorTab) => void
  fileCount: number
  onRefresh: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <>
      <PanelSeparator panelName="检查器" ratio={ratio} onRatioChange={onRatioChange} />
      <aside
        className="side-panel inspector-panel"
        aria-label={label}
        style={{ flexBasis: `calc((100% - var(--side-panel-separator-size)) * ${ratio})` }}
      >
        <header className="inspector-header">
          <div className="inspector-tabs" role="tablist" aria-label="检查器">
            {tabs.map((each) => (
              <button key={each} type="button" role="tab" aria-selected={tab === each} onClick={() => onTab(each)}>
                {TAB_LABEL[each]}{each === 'changes' && fileCount > 0 && <span className="count">{fileCount}</span>}
              </button>
            ))}
          </div>
          {tab !== 'plan' && (
            <button type="button" className="tool-button inspector-refresh" aria-label="刷新" data-tooltip="刷新" onClick={onRefresh}>
              <RefreshIcon />
            </button>
          )}
          <button type="button" className="tool-button" aria-label="收起检查器" data-tooltip="收起" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="inspector-body" role="tabpanel">
          {children}
        </div>
      </aside>
    </>
  )
}

// A row of the inspector: what it counts, the count as a pill, and anything else to say.
export function InspectorRow({ label, count, children }: { label: string; count?: string | number; children?: ReactNode }) {
  return (
    <div className="inspector-row">
      <span className="inspector-row-label">{label}</span>
      {count !== undefined && <span className="inspector-pill">{count}</span>}
      {children}
    </div>
  )
}

// The commits, folded behind a row with their count; at most 50 are read.
export function CommitList({ commits, label }: { commits: readonly Commit[]; label: string }) {
  const count = commits.length >= 50 ? '50+' : commits.length
  if (commits.length === 0) return <InspectorRow label={label} count={0} />
  return (
    <details className="inspector-commits">
      <summary className="inspector-row">
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <span className="inspector-row-label">{label}</span>
        <span className="inspector-pill">{count}</span>
      </summary>
      <ul>
        {commits.map((commit) => (
          <li key={commit.sha}>
            <span className="mono">{commit.sha}</span> {commit.subject}
          </li>
        ))}
      </ul>
    </details>
  )
}

// The files changed, under a row with how many and how much; `empty` reads when there are none.
export function ChangedFiles({ label, files, empty, onOpen }: { label: string; files: readonly ChangedFile[]; empty: string; onOpen: (file: string) => void }) {
  return (
    <>
      <InspectorRow label={label} count={files.length > 0 ? `${files.length} 个文件` : 0}>
        {files.length > 0 && <span className="inspector-row-counts mono">{lineTotals(files)}</span>}
      </InspectorRow>
      {files.length === 0 ? <p className="inspector-row-empty">{empty}</p> : <FileList files={files} onOpen={onOpen} />}
    </>
  )
}

function counts(file: ChangedFile): string {
  if (file.additions === null || file.deletions === null) return file.kind === 'untracked' ? '新文件' : '二进制'
  return `+${file.additions} −${file.deletions}`
}

export function lineTotals(files: readonly ChangedFile[]): string {
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  return `+${added} −${removed}`
}

export function FileList({ files, onOpen }: { files: readonly ChangedFile[]; onOpen: (file: string) => void }) {
  return (
    <ul className="changed-files">
      {files.map((file) => {
        const slash = file.path.lastIndexOf('/')
        return (
          <li key={file.path}>
            <button
              type="button"
              className="changed-file"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => onOpen(file.path)}
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
  )
}

// `load` is asked again whenever `loadKey` changes; a stale answer never replaces a newer one.
export function FileDiffView({ file, loadKey, load, onBack }: {
  file: string
  loadKey: string
  load: () => Promise<FileDiff>
  onBack: () => void
}) {
  const [result, setResult] = useState<{ key: string; diff: FileDiff | null; gone: boolean } | null>(null)
  useEffect(() => {
    let current = true
    void load().then(
      (diff) => current && setResult({ key: loadKey, diff, gone: false }),
      (error: unknown) => current && setResult({ key: loadKey, diff: null, gone: error instanceof RpcError && error.reason === 'file-not-changed' })
    )
    return () => {
      current = false
    }
  }, [loadKey])
  const shown = result?.key === loadKey ? result : null
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
        <p className="inspector-empty muted">{shown.gone ? '这个文件已经不在改动里了，可能已经被还原或提交。' : '读取 diff 失败。'}</p>
      ) : (
        <>
          <DiffLines patch={shown.diff.diff} />
          {shown.diff.truncated && <p className="inspector-empty muted">diff 太长，只显示了前 256KB。</p>}
        </>
      )}
    </div>
  )
}
