import { useCallback, useState, type FormEvent } from 'react'
import { MAX_TASK_REPOS, type TaskRepo } from '@kando/protocol'
import { perform } from '../core-store'
import { canPickFolder, pickFolder } from '../desktop-bridge'
import { Popover } from './Popover'

export function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

export function projectNames(paths: readonly string[]): string {
  return paths.length ? paths.map(projectName).join('、') : '无项目'
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

type ProjectEntry = Pick<TaskRepo, 'path' | 'branch' | 'worktreePath'>

// Controlled: shows `projects` and reports the new path list through `onChange`.
export function ProjectPicker({
  projects,
  onChange,
  locked = false,
  maxProjects = MAX_TASK_REPOS
}: {
  projects: readonly ProjectEntry[]
  onChange: (paths: string[]) => void
  locked?: boolean
  maxProjects?: number
}) {
  // Open menu → the recent projects it offers; null while closed.
  const [menu, setMenu] = useState<string[] | null>(null)
  const close = useCallback(() => setMenu(null), [])
  const paths = projects.map((project) => project.path)

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
      {projects.map((project) => (
        <span
          key={project.path}
          className="chip project-chip"
          title={project.worktreePath ? `${project.path}\nworktree：${project.worktreePath}` : project.path}
        >
          <span className="chip-main chip-static">
            <span className="project-name">{projectName(project.path)}</span>
            {project.branch && <span className="project-branch mono">{project.branch}</span>}
          </span>
          {!locked && (
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
