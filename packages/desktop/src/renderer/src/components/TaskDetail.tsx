import { useState } from 'react'
import { shortTaskId, type Task } from '@kando/protocol'
import { selectTask, updateTask, useCore } from '../core-store'
import { dayAndTime, STATUS_LABEL } from '../labels'
import { saveTaskText, unsavedTaskText, useTaskSaveState, type SaveState } from '../unsaved-edits'
import { MarkdownEditor } from './MarkdownEditor'
import { ProposalCard, RestoreBar } from './ProposalCard'
import { SourceLink } from './SourceLink'
import { SourceSnapshotCard } from './SourceSnapshotCard'
import { StatusIcon } from './StatusIcon'
import { TaskAlerts } from './TaskAlerts'
import { TaskImages, useImageAdder } from './TaskImages'
import { TaskToolbar } from './TaskActions'
import { DependencyPicker, TaskDependents } from './DependencyPicker'
import { ProjectPicker } from './ProjectPicker'

// Drafts are local and saved on blur so a remote update never clobbers typing.
function useDraft(value: string, save: (next: string) => void) {
  const [draft, setDraft] = useState(value)
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== value) {
        save(draft)
      }
    }
  }
}

const SAVE_TEXT: Record<SaveState, string> = {
  saving: '保存中…',
  saved: '已保存',
  failed: '保存失败，连上 core 后会自动重试'
}

function SaveIndicator({ taskId }: { taskId: string }) {
  const state = useTaskSaveState(taskId)
  return state && <span className="save-state" data-state={state} role="status">{SAVE_TEXT[state]}</span>
}

// Where a redo came from, or which task took over from an abandoned one.
function Lineage({ task, tasks }: { task: Task; tasks: Record<string, Task> }) {
  const link = (other: Task) => (
    <button type="button" className="link-button" onClick={() => selectTask(other.id)}>
      「{other.title}」
    </button>
  )
  if (task.status === 'abandoned') {
    const successor = Object.values(tasks).find((other) => other.derivedFrom === task.id)
    return (
      <p className="lineage" data-abandoned="true">
        已废弃{task.abandonReason ? `：${task.abandonReason}` : ''}。
        {successor && <>由{link(successor)}接着做，这次的 worktree 仍保留在磁盘上。</>}
      </p>
    )
  }
  const predecessor = task.derivedFrom ? tasks[task.derivedFrom] : undefined
  if (!predecessor) {
    return null
  }
  return (
    <p className="lineage">
      重做自{link(predecessor)}
      （已废弃{predecessor.abandonReason ? `：${predecessor.abandonReason}` : ''}）
    </p>
  )
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const task = useCore((s) => s.tasks[taskId])
  if (!task) {
    return null
  }
  return <TaskDetailBody task={task} />
}

function TaskDetailBody({ task }: { task: Task }) {
  const tasks = useCore((s) => s.tasks)
  // Text core has not confirmed yet wins over core's copy, so a failed save stays on screen.
  const title = useDraft(unsavedTaskText(task.id, 'title') ?? task.title, (next) => {
    if (next.trim()) {
      saveTaskText(task.id, 'title', next.trim())
    }
  })
  const dependents = Object.values(tasks).filter((other) => other.dependsOn.includes(task.id))
  // The editor reads its value once; bump this when the details change from elsewhere.
  const [editorRevision, setEditorRevision] = useState(0)
  const reloadEditor = () => setEditorRevision((revision) => revision + 1)
  const images = useImageAdder(task.id)

  return (
    <section className="detail task-detail" aria-label="任务详情" {...images.handlers}>
      <header className="detail-header">
        <span className="status-pill" data-status={task.status}>
          <StatusIcon status={task.status} decorative />
          {STATUS_LABEL[task.status]}
        </span>
        <TaskAlerts task={task} />
        <span className="muted mono">{shortTaskId(task.id)}</span>
        <SourceLink task={task} />
        <SaveIndicator taskId={task.id} />
        <TaskToolbar task={task} view="detail" />
      </header>

      <div className="task-detail-layout">
        <div className="task-detail-heading">
          <input className="input title-input" {...title} maxLength={200} aria-label="标题" />
          <Lineage task={task} tasks={tasks} />
        </div>

        <aside className="task-detail-side" aria-label="任务属性">
          <dl className="props">
            <dt>项目</dt>
            <dd>
              <ProjectPicker
                projects={task.repos}
                locked={task.status === 'running' || task.status === 'abandoned'}
                onChange={(repos) => void updateTask(task.id, { repos })}
              />
            </dd>
            <dt>依赖</dt>
            <dd>
              <DependencyPicker
                taskId={task.id}
                dependsOn={task.dependsOn}
                onChange={(dependsOn) => void updateTask(task.id, { dependsOn })}
              />
            </dd>
            <dt>图片</dt>
            <dd>
              <TaskImages task={task} uploading={images.uploading} onAddFiles={(files) => void images.add(files)} />
            </dd>
            {dependents.length > 0 && (
              <>
                <dt>被依赖</dt>
                <dd>
                  <TaskDependents dependents={dependents} />
                </dd>
              </>
            )}
          </dl>
          <p className="task-detail-created">创建于 {dayAndTime(task.createdAt)}</p>
        </aside>

        <div className="task-detail-main">
          <SourceSnapshotCard task={task} />
          <ProposalCard task={task} onApplied={reloadEditor} />
          <RestoreBar task={task} onRestored={reloadEditor} />

          <MarkdownEditor
            key={editorRevision}
            value={unsavedTaskText(task.id, 'details') ?? task.details}
            onSave={(next) => saveTaskText(task.id, 'details', next)}
            label="任务详情"
            hint="目标、背景、验收标准、需要注意的文件…支持 Markdown，写下后会作为 prompt 交给 agent"
          />
        </div>
      </div>
    </section>
  )
}
