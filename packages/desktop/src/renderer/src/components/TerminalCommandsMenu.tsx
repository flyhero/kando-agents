import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Terminal, TerminalCommand } from '@kando/protocol'
import { deleteTerminalCommand, saveTerminalCommand, showError, useCore } from '../core-store'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { commandTitle, offeredCommands, terminalProject } from '../terminal-commands'
import { BookmarkIcon, PencilIcon, PlusIcon } from './icons'
import { Popover } from './Popover'
import { projectName } from './ProjectPicker'
import { terminalSelection, typeIntoTerminal } from './terminal-surface'

type Draft = { id?: string; label: string; command: string; run: boolean; projectPath: string | null }

// Moves the focus along the menu's command rows, from the search box into the list and back.
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const menu = event.currentTarget.closest('.terminal-commands')
  const rows = [...(menu?.querySelectorAll<HTMLElement>('.terminal-command-item') ?? [])]
  if (rows.length === 0) return
  event.preventDefault()
  // -1 from the search box.
  const next = rows.findIndex((row) => row === document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1)
  if (next < 0) menu?.querySelector<HTMLElement>('.terminal-commands-search')?.focus()
  else rows[Math.min(next, rows.length - 1)]?.focus()
}

function CommandRow({ command, onSend, onEdit }: { command: TerminalCommand; onSend: () => void; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const title = commandTitle(command)
  return (
    <li className="menu-row terminal-command-row" onMouseLeave={() => setConfirming(false)}>
      <button
        type="button"
        className="menu-item terminal-command-item"
        title={command.run ? command.command : `${command.command}\n只填到命令行，不按回车`}
        onClick={onSend}
        onKeyDown={moveFocus}
      >
        <span className="terminal-command-text">
          <span className="menu-item-title">{title}</span>
          {command.label && <span className="terminal-command-line mono">{command.command}</span>}
        </span>
        {!command.run && <span className="terminal-command-tag">插入</span>}
      </button>
      <button type="button" className="icon-button" aria-label={`编辑 ${title}`} title="编辑" onClick={onEdit}>
        <PencilIcon />
      </button>
      <button
        type="button"
        className="icon-button terminal-command-delete"
        data-confirming={confirming || undefined}
        aria-label={confirming ? `确认删除 ${title}` : `删除 ${title}`}
        title={confirming ? '再点一次删除' : '删除'}
        onClick={() => (confirming ? deleteTerminalCommand(command.id) : setConfirming(true))}
        onBlur={() => setConfirming(false)}
      >
        {confirming ? '删除' : '×'}
      </button>
    </li>
  )
}

function CommandForm({
  draft,
  projectChoice,
  onSaved,
  onCancel
}: {
  draft: Draft
  // The folder a project-only command would be kept for; null when the terminal is in none.
  projectChoice: string | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(draft.label)
  const [command, setCommand] = useState(draft.command)
  const [run, setRun] = useState(draft.run)
  const [projectPath, setProjectPath] = useState(draft.projectPath)
  const [saving, setSaving] = useState(false)
  const canSave = command.trim().length > 0 && !saving

  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSave) return
    setSaving(true)
    const saved = await saveTerminalCommand({ id: draft.id, label: label.trim(), command: command.trim(), run, projectPath })
    setSaving(false)
    if (saved) onSaved()
  }

  return (
    <form className="terminal-command-form" onSubmit={(event) => void save(event)}>
      <div className="menu-label">{draft.id ? '编辑常用命令' : '添加常用命令'}</div>
      <textarea
        className="input mono terminal-command-input"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hasPrimaryModifier(event) && !event.nativeEvent.isComposing) void save()
        }}
        placeholder="命令，如 pnpm dev:core"
        aria-label="命令"
        rows={3}
        spellCheck={false}
        autoFocus
      />
      <input
        className="input"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="名称（可选），如「启动 core」"
        aria-label="名称"
        maxLength={80}
      />
      <label className="switch terminal-command-run">
        <input type="checkbox" role="switch" checked={run} onChange={(event) => setRun(event.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
        <span>
          直接执行
          <span className="muted">{run ? '：点一下就运行' : '：只填到命令行，按回车前还能改'}</span>
        </span>
      </label>
      {projectChoice && (
        <div className="segmented terminal-command-scope" role="radiogroup" aria-label="在哪些终端里显示">
          <button type="button" role="radio" aria-checked={projectPath === null} onClick={() => setProjectPath(null)}>
            所有终端
          </button>
          <button type="button" role="radio" aria-checked={projectPath !== null} title={projectChoice} onClick={() => setProjectPath(projectChoice)}>
            仅 {projectName(projectChoice)}
          </button>
        </div>
      )}
      <div className="terminal-command-actions">
        <button type="button" className="button ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={!canSave}>
          保存
          <kbd>{PRIMARY_KEY_LABEL}↵</kbd>
        </button>
      </div>
    </form>
  )
}

function TerminalCommandsMenu({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const commands = useCore((s) => s.terminalCommands)
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const project = useMemo(() => terminalProject(terminal.cwd, Object.values(tasks)), [terminal.cwd, tasks])
  // A shell opened outside any project (in home) offers no project to keep a command for.
  const knownProject = useMemo(
    () =>
      Object.values(tasks).some((task) => task.repos.some((repo) => repo.path === project)) ||
      Object.values(conversations).some((conversation) => conversation.projectPaths.includes(project)),
    [tasks, conversations, project]
  )
  const [query, setQuery] = useState('')
  const newDraft = (): Draft => ({ label: '', command: terminalSelection(terminal.sessionId).trim(), run: true, projectPath: null })
  // Nothing kept yet: go straight to adding one, with whatever is selected in the terminal.
  const [draft, setDraft] = useState<Draft | null>(() => (commands.length === 0 ? newDraft() : null))
  const offered = offeredCommands(commands, project, query)
  const all = [...offered.project, ...offered.global]
  const projectPaths = new Set(offered.project.map((command) => command.projectPath))
  const [onlyProject] = projectPaths
  const projectLabel = projectPaths.size === 1 && onlyProject ? projectName(onlyProject) : '当前项目'

  const send = (command: TerminalCommand) => {
    onClose()
    if (!typeIntoTerminal(terminal.sessionId, command.command, command.run)) showError('终端还没连上，稍后再试')
  }

  if (draft) {
    return (
      <Popover label="常用命令" onClose={onClose}>
        <CommandForm
          draft={draft}
          projectChoice={draft.projectPath ?? (knownProject ? project : null)}
          onSaved={() => setDraft(null)}
          onCancel={() => (commands.length === 0 ? onClose() : setDraft(null))}
        />
      </Popover>
    )
  }

  const rows = (list: TerminalCommand[]) => (
    <ul className="menu-list">
      {list.map((command) => (
        <CommandRow key={command.id} command={command} onSend={() => send(command)} onEdit={() => setDraft(command)} />
      ))}
    </ul>
  )

  return (
    <Popover label="常用命令" onClose={onClose}>
      <div className="terminal-commands">
        <input
          className="input menu-search terminal-commands-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && all[0]) {
              event.preventDefault()
              send(all[0])
            } else {
              moveFocus(event)
            }
          }}
          placeholder="搜索常用命令，回车运行第一条"
          aria-label="搜索常用命令"
        />
        {offered.project.length > 0 && (
          <>
            <div className="menu-label">{projectLabel}</div>
            {rows(offered.project)}
          </>
        )}
        {offered.global.length > 0 && (
          <>
            {offered.project.length > 0 && <div className="menu-label">所有终端</div>}
            {rows(offered.global)}
          </>
        )}
        {all.length === 0 && <p className="menu-note">{query.trim() ? '没有匹配的命令' : '这个终端还没有可用的常用命令'}</p>}
        <div className="menu-separator" />
        <button type="button" className="menu-item" onClick={() => setDraft(newDraft())}>
          <PlusIcon />
          添加常用命令
          <span className="menu-item-path">选中终端里的文字可直接带入</span>
        </button>
      </div>
    </Popover>
  )
}

// The terminal panel's saved commands: one click types a command into the shell that is shown.
export function TerminalCommandsButton({ terminal }: { terminal: Terminal | undefined }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="tool-button"
        aria-label="常用命令"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={open ? undefined : '常用命令'}
        disabled={!terminal}
        onClick={() => setOpen(!open)}
      >
        <BookmarkIcon />
      </button>
      {open && terminal && <TerminalCommandsMenu terminal={terminal} onClose={close} />}
    </span>
  )
}
