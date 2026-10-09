import { GitInspector } from './GitInspector'
import { useEffect, useState } from 'react'
import type { RepoChanges, Task } from '@kando/protocol'
import { pathShortener, type PlanItem } from '../chat-state'
import { clearInspectorFile, setInspectorOpen, setTaskInspectorTab, showInspectorFile, showTaskPlan, useCore } from '../core-store'
import { ProjectGroups, ProjectRow, useProjectHeads } from './BranchStatus'
import { ChatPlanView } from './ChatPlan'
import { ChangedFiles, CommitList, FileDiffView, GIT_TABS, InspectorPanel, useFocusCount, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'
import { WireLogView } from './WireLogView'
import { FilePreview } from './FilePreview'
import { EMPTY_FILE_TABS, updateFileTabs, useFileTabs } from '../file-tabs'

// Read again whenever the task changes (every agent turn and exit), the window regains focus,
// or the user refreshes. An older core without the method has nothing to show.
function useTaskChanges(taskId: string, updatedAt: number, refreshCount: number): RepoChanges[] | null {
  const gitRevision = useCore((state) => state.gitRevision)
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
  }, [rpc, taskId, updatedAt, focusCount, refreshCount, gitRevision])
  return changes?.taskId === taskId ? changes.changes : null
}

function ChangeList({ changes, onOpen }: { changes: RepoChanges[] | null; onOpen: (repo: string, file: string) => void }) {
  if (changes === null) return <p className="inspector-empty muted">正在读取改动…</p>
  const compared = changes.filter((repo) => repo.base)
  if (compared.length === 0) return <p className="inspector-empty muted">任务还没有 worktree，执行过之后这里会列出 Agent 的改动。</p>
  return (
    <div className="branch-status inspector-repos">
      <ProjectGroups items={compared}>
        {(repo, primary) => (
          <section key={repo.path} className="branch-status-project inspector-repo" data-primary={primary || undefined} aria-label={projectName(repo.path)}>
            <ProjectRow path={repo.path} branch={repo.branch}>
              <span className="inspector-row-since">从 <span className="mono">{repo.base}</span> 起</span>
            </ProjectRow>
            <CommitList commits={repo.commits} label="提交" />
            <ChangedFiles label="改动" files={repo.files} empty="和起点相比没有改动" onOpen={(file) => onOpen(repo.path, file)} />
          </section>
        )}
      </ProjectGroups>
    </div>
  )
}

// Beside the terminal: what the agent changed since its branch started, to judge a result under
// review before accepting it.
// A chat task's inspector also shows the plans its agent proposed, and has no git to show while the
// task only plans.
export function TaskInspector({ task, widthRatio, onWidthRatioChange, plans = [], planNote, wire = false }: {
  task: Task
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
  plans?: readonly PlanItem[]
  planNote?: (item: PlanItem) => string | null
  // The raw traffic with the task's chat agent (settings → 调试).
  wire?: boolean
}) {
  const conversationId = task.conversationId ?? ''
  const files = useFileTabs((state) => state[conversationId] ?? EMPTY_FILE_TABS)
  const gitRevision = useCore((state) => state.gitRevision)
  const rpc = useCore((state) => state.rpc)
  const wanted = useCore((state) => state.taskInspectorTab)
  const selectedPlan = useCore((state) => state.taskInspectorPlan)
  const worktree = task.repos.some((repo) => repo.worktreePath !== null)
  const tabs: InspectorTab[] = [...(worktree ? GIT_TABS : []), ...(plans.length > 0 ? ['plan' as const] : []), ...(wire && task.conversationId ? ['wire' as const] : []), ...(files.tabs.length > 0 ? ['files' as const] : [])]
  const tab = tabs.includes(wanted) ? wanted : (tabs[0] ?? 'changes')
  useEffect(() => {
    if (wanted !== 'files') updateFileTabs(conversationId, (state) => state.maximized ? { ...state, maximized: false } : state)
  }, [conversationId, wanted])
  useEffect(() => () => {
    updateFileTabs(conversationId, (state) => state.maximized ? { ...state, maximized: false } : state)
  }, [conversationId])
  const [refreshCount, setRefreshCount] = useState(0)
  const [gitMaximized, setGitMaximized] = useState(false)
  useEffect(() => { setGitMaximized(false) }, [wanted, task.id])

  const selected = useCore((state) => state.inspectorFile?.kind === 'task' && state.inspectorFile.id === task.id ? state.inspectorFile : null)
  const selectedFolder = task.repos.find((repo) => repo.path === selected?.project)?.worktreePath
  const changes = useTaskChanges(task.id, task.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'task', id: task.id }, task.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, repo) => sum + repo.files.length, 0) ?? 0
  const onEmpty = () => {
    const other = tabs.find((tab) => tab !== 'files')
    if (other) setTaskInspectorTab(other)
    else setInspectorOpen(false)
  }
  return (
    <InspectorPanel
      label="任务检查器"
      maximized={(tab === 'files' && files.maximized) || (tab === 'branch' && gitMaximized)}
      ratio={widthRatio}
      onRatioChange={onWidthRatioChange}
      tabs={tabs}
      tab={tab}
      onTab={setTaskInspectorTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setInspectorOpen(false)}
    >
      {tab === 'files' ? (
        <FilePreview conversationId={conversationId} updatedAt={task.updatedAt} inspector="task" onEmpty={onEmpty} />
      ) : tab === 'wire' && task.conversationId ? (
        <WireLogView conversationId={task.conversationId} />
      ) : tab === 'plan' ? (
        <ChatPlanView conversationId={task.conversationId ?? null} plans={plans} selected={selectedPlan} onSelect={showTaskPlan} note={planNote} />
      ) : tab === 'branch' ? (
        <GitInspector target={{ kind: 'task', id: task.id }} heads={heads} updatedAt={task.updatedAt} refresh={refreshCount} maximized={gitMaximized} onMaximize={() => setGitMaximized((value) => !value)} />
      ) : selected && rpc ? (
        <FileDiffView
          file={selectedFolder ? pathShortener([selectedFolder])(selected.file) : selected.file}
          loadKey={`${task.id}\0${selected.project}\0${selected.file}\0${selected.revision}\0${refreshCount}`}
          load={() => rpc.call('tasks.diff', { id: task.id, repo: selected.project, file: selected.file })}
          onBack={clearInspectorFile}
        />
      ) : (
        <ChangeList changes={changes} onOpen={(repo, file) => showInspectorFile('task', task.id, repo, file)} />
      )}
    </InspectorPanel>
  )
}
