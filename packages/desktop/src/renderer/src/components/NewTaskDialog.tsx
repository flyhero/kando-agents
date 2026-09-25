import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { AGENT_KINDS, AgentKind, type TaskImage } from '@kando/protocol'
import { dismissError, perform, selectTask, setNewTaskOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { AGENT_LABEL } from '../labels'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { DependencyPicker } from './DependencyPicker'
import { ProjectPicker } from './ProjectPicker'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { imageFilesOf, uploadImageFiles } from '../attachment-images'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="chevron" data-open={open} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function NewTaskDialog() {
  const tasks = useCore((s) => s.tasks)
  const connected = useCore((s) => s.connection === 'connected')
  const error = useCore((s) => s.error)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const ids = useId()
  const [title, setTitle] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [agent, setAgent] = useState<AgentKind | null>(() => defaultAgent(tasks))
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [details, setDetails] = useState('')
  const [images, setImages] = useState<TaskImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [viewing, setViewing] = useState<number | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [lastCreated, setLastCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // State lags a render behind; the ref stops a double press from creating twice.
  const submitting = useRef(false)
  const canSubmit = title.trim() !== '' && connected && !busy && uploading === 0

  // Images go up as soon as they are added; the task only names them on creation.
  const addImages = async (files: File[]) => {
    setAdvanced(true)
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
      className="modal"
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
      <div className="modal-body">
        <header className="modal-header">
          <h2 id={`${ids}-heading`}>新建任务</h2>
          <button type="button" className="icon-button modal-close" aria-label="关闭" onClick={close}>
            ×
          </button>
        </header>

        <label className="modal-field">
          <span className="modal-label">标题</span>
          <input
            ref={titleInput}
            className="input modal-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // ⌘↵ is handled by the dialog; composing Enter only commits the IME input.
              if (e.key === 'Enter' && !hasPrimaryModifier(e) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="要做什么？回车直接创建，详情以后再补"
            maxLength={200}
          />
        </label>

        <div className="modal-field">
          <span className="modal-label">项目</span>
          <ProjectPicker
            projects={repos.map((repoPath) => ({ path: repoPath, branch: null, worktreePath: null }))}
            onChange={setRepos}
          />
        </div>

        <label className="modal-field">
          <span className="modal-label">智能体</span>
          <select
            className="input modal-input"
            value={agent ?? ''}
            onChange={(e) => {
              const parsed = AgentKind.safeParse(e.target.value)
              setAgent(parsed.success ? parsed.data : null)
            }}
          >
            <option value="">以后再选</option>
            {AGENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {AGENT_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="modal-disclosure"
          aria-expanded={advanced}
          aria-controls={`${ids}-advanced`}
          onClick={() => setAdvanced((open) => !open)}
        >
          高级
          <Chevron open={advanced} />
        </button>
        {advanced && (
          <div id={`${ids}-advanced`} className="modal-advanced">
            <div className="modal-field">
              <span className="modal-label">
                依赖 <span className="modal-optional">[可选]</span>
              </span>
              <DependencyPicker taskId={null} dependsOn={dependsOn} onChange={setDependsOn} />
            </div>
            <label className="modal-field">
              <span className="modal-label">
                详情 <span className="modal-optional">[可选]</span>
              </span>
              <textarea
                className="input modal-textarea"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="目标、背景、验收标准…支持 Markdown，会作为 prompt 交给 agent"
                rows={4}
              />
            </label>
            <div className="modal-field">
              <span className="modal-label">
                图片 <span className="modal-optional">[可选，可以直接粘贴]</span>
              </span>
              <ImageStrip
                images={images}
                uploading={uploading}
                onOpen={setViewing}
                onAddFiles={(files) => void addImages(files)}
                onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))}
              />
            </div>
          </div>
        )}
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

        <footer className="modal-footer">
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
