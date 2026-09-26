import { useEffect, useState } from 'react'
import type { RepoChanges, Task } from '@kando/protocol'
import { setInspectorOpen, useCore } from '../core-store'
import { BranchStatusDetails, useProjectHeads } from './BranchStatus'
import { CommitList, FileDiffView, FileList, InspectorPanel, lineTotals, useFocusCount, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'

// Read again whenever the task changes (every agent turn and exit), the window regains focus,
// or the user refreshes. An older core without the method has nothing to show.
function useTaskChanges(taskId: string, updatedAt: number, refreshCount: number): RepoChanges[] | null {
  const rpc = useCore((state) => state.rpc)
  const focusCount = useFocusCount()
  const [changes, setChanges] = useState<{ taskId: string; changes: RepoChanges[] } | null>(null)
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

function summary(repo: RepoChanges): string {
  const commits = repo.commits.length >= 50 ? '至少 50 个提交' : `${repo.commits.length} 个提交`
  return `从 ${repo.base} 起 · ${commits} · ${repo.files.length} 个文件 · ${lineTotals(repo.files)}`
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
          {repo.commits.length > 0 && <CommitList commits={repo.commits} title="提交记录" />}
          {repo.files.length === 0
            ? <p className="muted">和起点相比没有改动。</p>
            : <FileList files={repo.files} onOpen={(file) => onOpen(repo.path, file)} />}
        </section>
      ))}
    </>
  )
}

// Beside the terminal: what the agent changed since its branch started, to judge a result under
// review before accepting it.
export function TaskInspector({ task, widthRatio, onWidthRatioChange }: {
  task: Task
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
}) {
  const rpc = useCore((state) => state.rpc)
  const [tab, setTab] = useState<InspectorTab>('changes')
  const [refreshCount, setRefreshCount] = useState(0)
  const [selected, setSelected] = useState<{ repo: string; file: string } | null>(null)
  const changes = useTaskChanges(task.id, task.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'task', id: task.id }, task.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, repo) => sum + repo.files.length, 0) ?? 0
  return (
    <InspectorPanel
      label="任务检查器"
      ratio={widthRatio}
      onRatioChange={onWidthRatioChange}
      tab={tab}
      onTab={setTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setInspectorOpen(false)}
    >
      {tab === 'branch' ? (
        heads.some((head) => head.branch) ? <BranchStatusDetails heads={heads} /> : <p className="inspector-empty muted">任务还没有 worktree，也就没有分支。</p>
      ) : selected && rpc ? (
        <FileDiffView
          file={selected.file}
          loadKey={`${selected.repo}\0${selected.file}\0${refreshCount}`}
          load={() => rpc.call('tasks.diff', { id: task.id, repo: selected.repo, file: selected.file })}
          onBack={() => setSelected(null)}
        />
      ) : (
        <ChangeList changes={changes} onOpen={(repo, file) => setSelected({ repo, file })} />
      )}
    </InspectorPanel>
  )
}
