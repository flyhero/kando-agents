import { useEffect, useState } from 'react'
import type { Conversation, FolderChanges } from '@kando/protocol'
import { usePlans } from '../chat-state'
import { setConversationInspectorOpen, setConversationInspectorTab, showConversationPlan, useCore } from '../core-store'
import { BranchStatusDetails, ProjectGroups, ProjectRow, useProjectHeads } from './BranchStatus'
import { ChatPlanView } from './ChatPlan'
import { ChangedFiles, CommitList, FileDiffView, GIT_TABS, InspectorPanel, useFocusCount, type InspectorTab } from './Inspector'
import { projectName } from './ProjectPicker'
import { WireLogView } from './WireLogView'
import { FilePreview } from './FilePreview'
import { EMPTY_FILE_TABS, updateFileTabs, useFileTabs } from '../file-tabs'

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
// Kando's own folder has no changes of the user's to show, only its plans. With wire set, the
// raw traffic with its agent too (settings → 调试).
export function ConversationInspector({ conversation, widthRatio, onWidthRatioChange, wire = false }: {
  conversation: Conversation
  widthRatio: number
  onWidthRatioChange: (ratio: number) => void
  wire?: boolean
}) {
  const conversationId = conversation.id
  const files = useFileTabs((state) => state[conversationId] ?? EMPTY_FILE_TABS)
  const rpc = useCore((state) => state.rpc)
  const wanted = useCore((state) => state.conversationInspectorTab)
  const selectedPlan = useCore((state) => state.conversationPlan)
  const plans = usePlans(conversation.id)
  const tabs: InspectorTab[] = [...(conversation.projectPaths.length > 0 ? GIT_TABS : []), ...(plans.length > 0 ? ['plan' as const] : []), ...(wire ? ['wire' as const] : []), ...(files.tabs.length > 0 ? ['files' as const] : [])]
  const tab = tabs.includes(wanted) ? wanted : (tabs[0] ?? 'changes')
  useEffect(() => {
    if (wanted !== 'files') updateFileTabs(conversationId, (state) => state.maximized ? { ...state, maximized: false } : state)
  }, [conversationId, wanted])
  useEffect(() => () => {
    updateFileTabs(conversationId, (state) => state.maximized ? { ...state, maximized: false } : state)
  }, [conversationId])
  const [refreshCount, setRefreshCount] = useState(0)
  const [selected, setSelected] = useState<{ project: string; file: string } | null>(null)
  const changes = useFolderChanges(conversation.id, conversation.updatedAt, refreshCount)
  const heads = useProjectHeads({ kind: 'conversation', id: conversation.id }, conversation.updatedAt, refreshCount)
  const fileCount = changes?.reduce((sum, folder) => sum + folder.files.length, 0) ?? 0
  const onEmpty = () => {
    const other = tabs.find((tab) => tab !== 'files')
    if (other) setConversationInspectorTab(other)
    else setConversationInspectorOpen(false)
  }
  return (
    <InspectorPanel
      label="会话检查器"
      maximized={tab === 'files' && files.maximized}
      ratio={widthRatio}
      onRatioChange={onWidthRatioChange}
      tabs={tabs}
      tab={tab}
      onTab={setConversationInspectorTab}
      fileCount={fileCount}
      onRefresh={() => setRefreshCount((count) => count + 1)}
      onClose={() => setConversationInspectorOpen(false)}
    >
      {tab === 'files' ? (
        <FilePreview conversationId={conversationId} updatedAt={conversation.updatedAt} inspector="conversation" onEmpty={onEmpty} />
      ) : tab === 'wire' ? (
        <WireLogView conversationId={conversation.id} />
      ) : tab === 'plan' ? (
        <ChatPlanView conversationId={conversation.id} plans={plans} selected={selectedPlan} onSelect={showConversationPlan} />
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
