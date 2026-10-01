import { useEffect, useState } from 'react'
import type { Conversation, FolderChanges } from '@kando/protocol'
import { usePlans } from '../chat-state'
import { setConversationInspectorOpen, setConversationInspectorTab, showConversationPlan, useCore } from '../core-store'
import { BranchStatusDetails, ProjectGroups, ProjectRow, useProjectHeads } from './BranchStatus'
import { ChatPlanView } from './ChatPlan'
import { ChangedFiles, CommitList, FileDiffView, GIT_TABS, InspectorPanel, useFocusCount, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'

// Read again whenever the conversation changes (every agent turn and exit), the window regains
// focus, or the user refreshes. An older core without the method has nothing to show.
export function useFolderChanges(id: string, updatedAt: number, refreshCount: number): FolderChanges[] | null {
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
    <div className="branch-status inspector-repos">
      <ProjectGroups items={repos}>
        {(folder, primary) => (
          <section key={folder.path} className="branch-status-project inspector-repo" data-primary={primary || undefined} aria-label={projectName(folder.path)}>
            <ProjectRow path={folder.path} branch={folder.branch} />
            {folder.commits === null
              ? <p className="inspector-row-empty">会话开始时还没有记录起点，看不到这之后的提交</p>
              : <CommitList commits={folder.commits} label="本次会话的提交" />}
            <ChangedFiles label="未提交的改动" files={folder.files} empty="没有未提交的改动" onOpen={(file) => onOpen(folder.path, file)} />
          </section>
        )}
      </ProjectGroups>
      <p className="branch-status-note">项目目录和你共用，未提交的改动里也可能有你自己的。</p>
    </div>
  )
}

// Beside the transcript, opened by the user or by a plan the agent proposes. A conversation in
// Kando's own folder has no changes of the user's to show, only its plans.
export function ConversationInspector({ conversation, widthRatio, onWidthRatioChange }: {
  conversation: Conversation
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
}) {
  const rpc = useCore((state) => state.rpc)
  const wanted = useCore((state) => state.conversationInspectorTab)
  const selectedPlan = useCore((state) => state.conversationPlan)
  const plans = usePlans(conversation.id)
  const tabs: InspectorTab[] = [...(conversation.projectPaths.length > 0 ? GIT_TABS : []), ...(plans.length > 0 ? ['plan' as const] : [])]
  const tab = tabs.includes(wanted) ? wanted : (tabs[0] ?? 'changes')
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
      tabs={tabs}
      tab={tab}
      onTab={setConversationInspectorTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setConversationInspectorOpen(false)}
    >
      {tab === 'plan' ? (
        <ChatPlanView plans={plans} selected={selectedPlan} onSelect={showConversationPlan} />
      ) : tab === 'branch' ? (
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
