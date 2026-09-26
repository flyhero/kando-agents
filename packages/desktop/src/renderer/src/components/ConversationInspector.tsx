import { useEffect, useState } from 'react'
import type { Conversation, FolderChanges } from '@kando/protocol'
import { setConversationInspectorOpen, useCore } from '../core-store'
import { BranchStatusDetails, useProjectHeads } from './BranchStatus'
import { CommitList, FileDiffView, FileList, InspectorPanel, lineTotals, useFocusCount, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'

// Read again whenever the conversation changes (every agent turn and exit), the window regains
// focus, or the user refreshes. An older core without the method has nothing to show.
function useFolderChanges(id: string, updatedAt: number, refreshCount: number): FolderChanges[] | null {
  const rpc = useCore((state) => state.rpc)
  const focusCount = useFocusCount()
  const [changes, setChanges] = useState<{ id: string; changes: FolderChanges[] } | null>(null)
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('conversations.changes', { id })
      .catch(() => [])
      .then((found) => {
        if (current) setChanges({ id, changes: found })
      })
    return () => {
      current = false
    }
  }, [rpc, id, updatedAt, focusCount, refreshCount])
  return changes?.id === id ? changes.changes : null
}

function ChangeList({ changes, onOpen }: { changes: FolderChanges[] | null; onOpen: (project: string, file: string) => void }) {
  if (changes === null) return <p className="inspector-empty muted">正在读取改动…</p>
  const repos = changes.filter((folder) => folder.head !== null || folder.files.length > 0)
  if (repos.length === 0) return <p className="inspector-empty muted">这个会话的项目不在 git 仓库里，没有可以对比的改动。</p>
  return (
    <>
      {repos.map((folder) => (
        <section key={folder.path} className="inspector-repo" aria-label={projectName(folder.path)}>
          {repos.length > 1 && <h3 className="inspector-repo-name">{projectName(folder.path)}</h3>}
          <h4 className="inspector-section-title">本次会话以来的提交</h4>
          {folder.commits === null ? (
            <p className="inspector-summary muted">这个会话开始时 Kando 还没有记录起点，只能看到还没提交的改动。</p>
          ) : folder.commits.length === 0 ? (
            <p className="inspector-summary muted">还没有新的提交。</p>
          ) : (
            <CommitList commits={folder.commits} title={folder.commits.length >= 50 ? '至少 50 个提交' : `${folder.commits.length} 个提交`} />
          )}
          <h4 className="inspector-section-title">
            还没提交的改动
            {folder.files.length > 0 && <span className="muted"> · {folder.files.length} 个文件 · {lineTotals(folder.files)}</span>}
          </h4>
          <p className="inspector-summary muted">项目目录是和你共用的，这里也可能包含你自己的改动。</p>
          {folder.files.length === 0
            ? <p className="muted">没有还没提交的改动。</p>
            : <FileList files={folder.files} onOpen={(file) => onOpen(folder.path, file)} />}
        </section>
      ))}
    </>
  )
}

// Beside the transcript, opened by the user: a conversation has no review step to open it for them.
export function ConversationInspector({ conversation, widthRatio, onWidthRatioChange }: {
  conversation: Conversation
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
}) {
  const rpc = useCore((state) => state.rpc)
  const [tab, setTab] = useState<InspectorTab>('changes')
  const [refreshCount, setRefreshCount] = useState(0)
  const [selected, setSelected] = useState<{ project: string; file: string } | null>(null)
  const changes = useFolderChanges(conversation.id, conversation.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'conversation', id: conversation.id }, conversation.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, folder) => sum + folder.files.length, 0) ?? 0
  return (
    <InspectorPanel
      label="会话检查器"
      ratio={widthRatio}
      onRatioChange={onWidthRatioChange}
      tab={tab}
      onTab={setTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setConversationInspectorOpen(false)}
    >
      {tab === 'branch' ? (
        heads.some((head) => head.branch) ? <BranchStatusDetails heads={heads} /> : <p className="inspector-empty muted">这个会话的项目不在 git 仓库里，没有分支。</p>
      ) : selected && rpc ? (
        <FileDiffView
          file={selected.file}
          loadKey={`${selected.project}\0${selected.file}\0${refreshCount}`}
          load={() => rpc.call('conversations.diff', { id: conversation.id, project: selected.project, file: selected.file })}
          onBack={() => setSelected(null)}
        />
      ) : (
        <ChangeList changes={changes} onOpen={(project, file) => setSelected({ project, file })} />
      )}
    </InspectorPanel>
  )
}
