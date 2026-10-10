import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { AgentKind } from '@kando/protocol'
import { perform, setNewTaskOpen, useCore } from '../core-store'
import { defaultAgent } from '../default-agent'
import { canPickFolder, pickFolder } from '../desktop-bridge'
import { useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { latestProjects } from '../task-board'
import { ContextMenu, MenuRadioItem, type MenuPoint } from './ContextMenu'
import { AgentIcon, ChevronDownIcon, FolderIcon } from './icons'
import { parentDir, projectName, projectNames } from './ProjectPicker'

// What is being written, kept while the board is away so a half-written title is still there.
// Projects and agent are null until the first open, which takes them from the latest task; after
// that they stay as picked, since a batch of tasks usually shares them.
type QuickAdd = { open: boolean; title: string; repos: readonly string[] | null; agent: AgentKind | null | undefined }
const useQuickAdd = create<QuickAdd>(() => ({ open: false, title: '', repos: null, agent: undefined }))

export function openQuickAdd(): void {
  const { tasks } = useCore.getState()
  useQuickAdd.setState((s) => ({
    open: true,
    repos: s.repos ?? latestProjects(Object.values(tasks)),
    agent: s.agent === undefined ? defaultAgent(tasks) : s.agent
  }))
}

// Writing a task down at the top of the pending column: Enter creates it and leaves the field for
// the next, Shift+Enter carries it into the full dialog, Esc or a click elsewhere folds it away.
export function TaskQuickAdd({ onCreated }: { onCreated: (id: string) => void }) {
  const { open, title, repos, agent } = useQuickAdd()
  const connected = useCore((s) => s.connection === 'connected')
  const editor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const fold = useCallback(() => useQuickAdd.setState({ open: false }), [])

  // A click outside folds it, but not one in a menu it opened, which is portaled elsewhere.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !editor.current?.contains(event.target) && !event.target.closest('[role="menu"]')) fold()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, fold])

  // The title grows with what is written rather than scrolling inside one line.
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [title, open])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button type="button" className="task-quick-add-row" onClick={openQuickAdd}>
        ＋ 写下一个任务
        <kbd>N</kbd>
      </button>
    )
  }

  const draft = { title: title.trim(), repos: repos ?? [], agent: agent ?? null }
  const createTask = async () => {
    if (!draft.title || busy || !connected) return
    setBusy(true)
    const task = await perform((rpc) => rpc.call('tasks.create', { title: draft.title, repos: [...draft.repos], agent: draft.agent }))
    setBusy(false)
    if (!task) return
    useQuickAdd.setState({ title: '' })
    onCreated(task.id)
    input.current?.focus()
  }

  return (
    <div ref={editor} className="task-quick-add" aria-busy={busy}>
      <textarea
        ref={input}
        className="task-quick-add-title"
        rows={1}
        aria-label="新任务的标题"
        placeholder="要做什么？一句话就够"
        value={title}
        maxLength={200}
        onChange={(event) => useQuickAdd.setState({ title: event.target.value.replace(/\n/g, ' ') })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault()
            useQuickAdd.setState({ open: false, title: '' })
            setNewTaskOpen(true, draft)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            void createTask()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            fold()
          }
        }}
      />
      <div className="task-quick-add-picks">
        <ProjectPick repos={draft.repos} />
        <AgentPick agent={draft.agent} />
      </div>
      <div className="task-quick-add-hint">
        <span><kbd>↵</kbd> 创建</span>
        <span><kbd>⇧↵</kbd> 更多选项</span>
        <span><kbd>Esc</kbd> 收起</span>
      </div>
    </div>
  )
}

function useMenuAt() {
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  const toggle = () => {
    const box = button.current?.getBoundingClientRect()
    if (box) setAt((current) => (current ? null : { x: box.left, y: box.bottom + 4 }))
  }
  return { button, at, close, toggle }
}

// One project for the new task, from those used lately; several, or none, in the full dialog too.
function ProjectPick({ repos }: { repos: readonly string[] }) {
  const { button, at, close, toggle } = useMenuAt()
  const [recent, setRecent] = useState<readonly string[]>([])
  const choose = (next: readonly string[]) => {
    useQuickAdd.setState({ repos: next })
    close()
  }
  const browse = async () => {
    close()
    const picked = await pickFolder(repos[0] ? parentDir(repos[0]) : undefined)
    if (picked) useQuickAdd.setState({ repos: [picked] })
  }
  const choices = [...new Set([...repos, ...recent])]
  return (
    <>
      <button
        ref={button}
        type="button"
        className="task-quick-add-pick"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        data-empty={repos.length === 0 || undefined}
        title={repos.join('\n') || undefined}
        onClick={() => {
          toggle()
          if (!at) void perform((rpc) => rpc.call('projects.recent', {})).then((found) => setRecent(found ?? []))
        }}
      >
        <FolderIcon />
        {repos.length ? projectNames(repos) : '选择项目'}
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} trigger={button.current} label="新任务的项目" onClose={close}>
          {choices.map((each) => (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={repos.length === 1 && repos[0] === each}
              className="menu-item"
              title={each}
              onClick={() => choose([each])}
            >
              <span className="menu-item-name">{projectName(each)}</span>
              <span className="menu-item-path mono">{each}</span>
            </button>
          ))}
          {canPickFolder() && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => void browse()}>选择文件夹…</button>
          )}
          <div className="menu-separator" role="separator" />
          <MenuRadioItem label="无项目，之后再选" checked={repos.length === 0} onSelect={() => choose([])} />
        </ContextMenu>
      )}
    </>
  )
}

function AgentPick({ agent }: { agent: AgentKind | null }) {
  const { button, at, close, toggle } = useMenuAt()
  const installed = useInstalledAgents()
  const choices = agent && !installed.includes(agent) ? [...installed, agent] : installed
  return (
    <>
      <button
        ref={button}
        type="button"
        className="task-quick-add-pick"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        data-empty={agent === null || undefined}
        onClick={toggle}
      >
        <span className="task-quick-add-agent"><AgentIcon agent={agent} /></span>
        {agent ? AGENT_LABEL[agent] : '选择 Agent'}
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} trigger={button.current} label="新任务的 Agent" onClose={close}>
          {choices.map((each) => (
            <MenuRadioItem key={each} label={AGENT_LABEL[each]} checked={each === agent} onSelect={() => {
              useQuickAdd.setState({ agent: each })
              close()
            }} />
          ))}
          <MenuRadioItem label="之后再选" checked={agent === null} onSelect={() => {
            useQuickAdd.setState({ agent: null })
            close()
          }} />
        </ContextMenu>
      )}
    </>
  )
}
