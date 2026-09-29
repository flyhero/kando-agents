import { useCallback, useState, type FormEvent } from 'react'
import { MAX_TASK_REPOS, type TaskRepo } from '@kando/protocol'
import { perform } from '../core-store'
import { canPickFolder, pickFolder } from '../desktop-bridge'
import { ContextMenu, MenuItem, menuPoint, type MenuPoint } from './ContextMenu'
import { Popover } from './Popover'

export function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

export function projectNames(paths: readonly string[]): string {
  return paths.length ? paths.map(projectName).join('、') : '无项目'
}

export function projectSummary(paths: readonly string[]): string {
  const [primary, ...additional] = paths
  return primary ? `主项目：${projectName(primary)}${additional.length ? ` · 附加：${projectNames(additional)}` : ''}` : '无项目'
}

function parentDir(projectPath: string): string | undefined {
  const parent = projectPath.replace(/[\\/]+[^\\/]+[\\/]*$/, '')
  return parent && parent !== projectPath ? parent : undefined
}

// Only reachable in a plain browser, where there is no native folder dialog.
function PathForm({ onSubmit }: { onSubmit: (projectPath: string) => void }) {
  const [draft, setDraft] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (draft.trim()) {
      onSubmit(draft.trim())
    }
  }
  return (
    <form className="menu-form" onSubmit={submit}>
      <input
        className="input mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="项目的绝对路径，如 ~/IdeaProjects/app"
        aria-label="项目路径"
        autoFocus
      />
      <button type="submit" className="button" disabled={!draft.trim()}>
        添加
      </button>
    </form>
  )
}

function ProjectMenu({
  recent,
  onAdd,
  onBrowse,
  onForget,
  onClose
}: {
  recent: readonly string[]
  onAdd: (projectPath: string) => void
  onBrowse: () => void
  onForget: (projectPath: string) => void
  onClose: () => void
}) {
  return (
    <Popover label="添加项目" onClose={onClose}>
      {recent.length > 0 && (
        <>
          <div className="menu-label">最近使用</div>
          <ul className="menu-list">
            {recent.map((projectPath) => (
              <li key={projectPath} className="menu-row">
                <button type="button" className="menu-item" title={projectPath} onClick={() => onAdd(projectPath)}>
                  <span className="menu-item-name">{projectName(projectPath)}</span>
                  <span className="menu-item-path mono">{projectPath}</span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="从最近使用中移除（不影响已有任务或会话）"
                  aria-label={`从最近使用中移除 ${projectName(projectPath)}`}
                  onClick={() => onForget(projectPath)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="menu-separator" />
        </>
      )}
      {canPickFolder() ? (
        <button type="button" className="menu-item" onClick={onBrowse}>
          选择其他文件夹…
        </button>
      ) : (
        <PathForm onSubmit={onAdd} />
      )}
    </Popover>
  )
}

type ProjectEntry = Pick<TaskRepo, 'path' | 'worktreePath'>

// Controlled: shows `projects` and reports the new path list through `onChange`. With
// `primaryLocked`, projects can still be added and removed but the first one stays first.
export function ProjectPicker({
  projects,
  onChange,
  locked = false,
  primaryLocked = false,
  maxProjects = MAX_TASK_REPOS
}: {
  projects: readonly ProjectEntry[]
  onChange: (paths: string[]) => void
  locked?: boolean
  primaryLocked?: boolean
  maxProjects?: number
}) {
  // Open menu → the recent projects it offers; null while closed.
  const [menu, setMenu] = useState<string[] | null>(null)
  const close = useCallback(() => setMenu(null), [])
  // An additional project's right-click menu, which makes it the primary one.
  const [projectMenu, setProjectMenu] = useState<{ path: string; at: MenuPoint } | null>(null)
  const closeProjectMenu = useCallback(() => setProjectMenu(null), [])
  const paths = projects.map((project) => project.path)
  const promotable = !locked && !primaryLocked
  const promote = (projectPath: string) => {
    setProjectMenu(null)
    onChange([projectPath, ...paths.filter((each) => each !== projectPath)])
  }

  const add = (projectPath: string) => {
    setMenu(null)
    onChange([...paths, projectPath])
  }

  const browse = async (recent: readonly string[]) => {
    setMenu(null)
    const picked = await pickFolder(recent[0] ? parentDir(recent[0]) : undefined)
    if (picked) {
      add(picked)
    }
  }

  const open = async () => {
    const recent = ((await perform((rpc) => rpc.call('projects.recent', {}))) ?? []).filter(
      (projectPath) => !paths.includes(projectPath)
    )
    // Nothing to choose from yet: go straight to the folder dialog.
    if (recent.length === 0 && canPickFolder()) {
      await browse(recent)
    } else {
      setMenu(recent)
    }
  }

  const forget = async (projectPath: string) => {
    if (await perform((rpc) => rpc.call('projects.forget', { path: projectPath }))) {
      setMenu((current) => current?.filter((entry) => entry !== projectPath) ?? null)
    }
  }

  return (
    <div className="chip-field">
      {/* The primary project stands out by colour; another becomes primary from its right-click menu. */}
      {projects.map((project, index) => (
        <span
          key={project.path}
          className="chip project-chip"
          data-primary={index === 0 || undefined}
          title={[
            index === 0 ? `主项目：${project.path}` : project.path,
            project.worktreePath && `worktree：${project.worktreePath}`,
            promotable && index > 0 && '右键可设为主项目',
            !locked && primaryLocked && index === 0 && '对话开始后不能更换主项目'
          ].filter(Boolean).join('\n')}
          onContextMenu={promotable && index > 0 ? (event) => {
            event.preventDefault()
            setProjectMenu({ path: project.path, at: menuPoint(event) })
          } : undefined}
        >
          <span className="chip-main chip-static">
            <span className="project-name">{projectName(project.path)}</span>
            {index === 0 && <span className="visually-hidden">（主项目）</span>}
          </span>
          {!locked && !(primaryLocked && index === 0) && (
            <button
              type="button"
              className="chip-remove"
              title="移除项目（不会删除目录或已有 worktree）"
              aria-label={`移除 ${projectName(project.path)}`}
              onClick={() => onChange(paths.filter((projectPath) => projectPath !== project.path))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {projectMenu && (
        <ContextMenu at={projectMenu.at} label={`${projectName(projectMenu.path)} 的操作`} onClose={closeProjectMenu}>
          <MenuItem label="设为主项目" onSelect={() => promote(projectMenu.path)} />
        </ContextMenu>
      )}
      {!locked && paths.length < maxProjects && (
        <span className="menu-anchor">
          <button
            type="button"
            className="chip chip-add-button"
            aria-haspopup="dialog"
            aria-expanded={menu !== null}
            onClick={() => (menu ? setMenu(null) : void open())}
          >
            ＋ 添加项目
          </button>
          {menu && (
            <ProjectMenu
              recent={menu}
              onAdd={add}
              onBrowse={() => void browse(menu)}
              onForget={(projectPath) => void forget(projectPath)}
              onClose={close}
            />
          )}
        </span>
      )}
      {locked && projects.length === 0 && <span className="muted">未设置</span>}
    </div>
  )
}
