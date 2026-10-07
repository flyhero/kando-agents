import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { AgentKind, IMAGE_MIME_TYPES, type TaskImage } from '@kando/protocol'
import { dismissError, perform, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { AgentQuotaHint } from './AgentQuota'
import { DependencyPicker } from './DependencyPicker'
import { ProjectPicker } from './ProjectPicker'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { imageFilesOf, uploadImageFiles } from '../attachment-images'
import { AgentIcon, CloseIcon, MaximizeIcon, MoreIcon, RestoreIcon } from './icons'
import { Popover } from './Popover'
import { MarkdownEditor } from './MarkdownEditor'

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7.3 11.9 5.2-5.2a2.3 2.3 0 0 1 3.3 3.3l-6.6 6.6a4 4 0 0 1-5.7-5.7l6.7-6.7a1.7 1.7 0 0 1 2.4 2.4l-6.6 6.6" />
    </svg>
  )
}

export function NewTaskDialog() {
  const tasks = useCore((s) => s.tasks)
  const connected = useCore((s) => s.connection === 'connected')
  const error = useCore((s) => s.error)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const ids = useId()
  const [title, setTitle] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [agent, setAgent] = useState<AgentKind | null>(() => defaultAgent(tasks))
  const installed = useInstalledAgents()
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [details, setDetails] = useState('')
  // The details editor holds its own text; a new key starts it empty for the next task.
  const [detailsKey, setDetailsKey] = useState(0)
  const [images, setImages] = useState<TaskImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [viewing, setViewing] = useState<number | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [lastCreated, setLastCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // State lags a render behind; the ref stops a double press from creating twice.
  const submitting = useRef(false)
  const canSubmit = title.trim() !== '' && connected && !busy && uploading === 0

  // Images go up as soon as they are added; the task only names them on creation.
  const addImages = async (files: File[]) => {
    setUploading((count) => count + files.length)
    const added = await uploadImageFiles(files)
    setUploading((count) => count - files.length)
    setImages((current) => [...current, ...added.filter((image) => !current.some((each) => each.id === image.id))])
  }

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    // showModal focuses the first focusable element (the close button); React's
    // autoFocus never sets the attribute it would honor instead.
    titleInput.current?.focus()
    dismissError()
    return () => element?.close()
  }, [])

  const close = () => setNewTaskOpen(false)

  async function submit() {
    if (!canSubmit || submitting.current) {
      return
    }
    submitting.current = true
    setBusy(true)
    dismissError()
    const task = await perform((rpc) =>
      rpc.call('tasks.create', {
        title: title.trim(),
        details: details.trim() ? details : undefined,
        repos,
        dependsOn,
        agent,
        images: images.map(({ id, name }) => ({ id, name }))
      })
    )
    submitting.current = false
    setBusy(false)
    if (!task) {
      return
    }
    if (createMore) {
      // Keep repos and agent: a batch of tasks usually shares them.
      setTitle('')
      setDetails('')
      setDetailsKey((key) => key + 1)
      setDependsOn([])
      setImages([])
      setLastCreated(task.title)
      titleInput.current?.focus()
    } else {
      selectTask(task.id)
      close()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && hasPrimaryModifier(event)) {
      event.preventDefault()
      void submit()
    }
  }

  // The dialog element itself is only hit on the backdrop; its content fills it.
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === dialog.current) {
      close()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal new-task-dialog"
      data-expanded={expanded || undefined}
      aria-labelledby={`${ids}-heading`}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
      onPaste={(event) => {
        const files = imageFilesOf(event.clipboardData)
        if (files.length > 0) {
          event.preventDefault()
          void addImages(files)
        }
      }}
      onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDrop={(event) => {
        const files = imageFilesOf(event.dataTransfer)
        if (files.length > 0) {
          event.preventDefault()
          void addImages(files)
        }
      }}
    >
      <div className="modal-body new-task-body">
        <header className="new-task-header">
          <div className="new-task-breadcrumb">
            <span>Kando</span>
            <span className="new-task-breadcrumb-separator" aria-hidden="true">›</span>
            <h2 id={`${ids}-heading`}>手动创建</h2>
          </div>
          <div className="new-task-window-actions">
            <button type="button" className="icon-button" aria-label={expanded ? '还原窗口' : '展开窗口'} onClick={() => setExpanded((value) => !value)}>
              {expanded ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={close}>
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="new-task-editor">
          <input
            ref={titleInput}
            className="new-task-title"
            aria-label="任务标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // ⌘↵ is handled by the dialog; composing Enter only commits the IME input.
              if (e.key === 'Enter' && !hasPrimaryModifier(e) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="任务标题"
            maxLength={200}
          />
          <MarkdownEditor
            key={detailsKey}
            className="new-task-details"
            value=""
            onChange={setDetails}
            onSubmit={() => void submit()}
            label="任务详情"
            hint="添加详情...（支持 Markdown）"
          />
        </div>

        {(images.length > 0 || uploading > 0) && (
          <div className="new-task-images">
            <ImageStrip
              images={images}
              uploading={uploading}
              onOpen={setViewing}
              onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))}
            />
          </div>
        )}

        <div className="new-task-properties">
          <ProjectPicker
            projects={repos.map((repoPath) => ({ path: repoPath, worktreePath: null }))}
            onChange={setRepos}
            compact
          />
          <label className="new-task-agent-chip">
            <AgentIcon agent={agent} />
            <span>{agent ? AGENT_LABEL[agent] : '选择 Agent'}</span>
            <select
              aria-label="选择 Agent"
              value={agent ?? ''}
              onChange={(e) => {
                const parsed = AgentKind.safeParse(e.target.value)
                setAgent(parsed.success ? parsed.data : null)
              }}
            >
              <option value="">以后再选</option>
              {installed.map((kind) => (
                <option key={kind} value={kind}>{AGENT_LABEL[kind]}</option>
              ))}
            </select>
          </label>
          <span className="menu-anchor">
            <button type="button" className="new-task-property-chip" aria-label="更多选项" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
              <MoreIcon />
            </button>
            {moreOpen && (
              <Popover label="更多任务选项" onClose={() => setMoreOpen(false)}>
                <div className="new-task-more-content">
                  <span className="modal-label">依赖任务</span>
                  <DependencyPicker taskId={null} dependsOn={dependsOn} onChange={setDependsOn} />
                  {agent && <AgentQuotaHint agent={agent} />}
                </div>
              </Popover>
            )}
          </span>
          {dependsOn.length > 0 && <span className="new-task-dependency-count">依赖 {dependsOn.length} 项</span>}
        </div>
        {viewing !== null && images.length > 0 && (
          <ImageViewer
            images={images}
            index={Math.min(viewing, images.length - 1)}
            onIndex={setViewing}
            onClose={() => setViewing(null)}
            onRename={(id, name) => setImages((current) => current.map((image) => (image.id === id ? { ...image, name } : image)))}
          />
        )}

        {/* The app's toast renders below the modal's top layer, so errors show here instead. */}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <footer className="modal-footer new-task-footer">
          <button type="button" className="new-task-attach" aria-label="添加图片" title="添加图片，也可以直接粘贴或拖入" onClick={() => imageInput.current?.click()}>
            <PaperclipIcon />
          </button>
          <input
            ref={imageInput}
            type="file"
            hidden
            multiple
            accept={IMAGE_MIME_TYPES.join(',')}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) void addImages(files)
            }}
          />
          <span className="new-task-footer-spacer" />
          <label className="switch">
            <input type="checkbox" role="switch" checked={createMore} onChange={(e) => setCreateMore(e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            创建更多
          </label>
          {createMore && lastCreated && <span className="muted modal-created">已创建「{lastCreated}」</span>}
          <button type="button" className="button primary modal-submit" disabled={!canSubmit} onClick={() => void submit()}>
            创建任务
            <kbd>{PRIMARY_KEY_LABEL}↵</kbd>
          </button>
        </footer>
      </div>
    </dialog>
  )
}
