export type InspectorFile = {
  kind: 'task' | 'conversation'
  id: string
  project: string
  file: string
  revision: number
}

type ProjectFolder = { project: string; folder: string }

// Renderer paths belong to core's platform, which may differ from the desktop's.
function normalized(path: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path)
  const forward = windows ? path.replaceAll('\\', '/') : path
  const prefix = /^[a-z]:\//i.exec(forward)?.[0] ?? (forward.startsWith('//') ? '//' : '/')
  const parts: string[] = []
  for (const part of forward.slice(prefix.length).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return prefix + parts.join('/')
}

export function locateInspectorFile(path: string, cwd: string, projects: readonly ProjectFolder[]): { project: string; file: string } | null {
  const absolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)
  const file = normalized(absolute ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)
  const windows = /^[a-z]:\/|^\/\//i.test(file)
  const compare = (value: string) => windows ? value.toLowerCase() : value
  const matching = projects.filter(({ folder }) => {
    const root = normalized(folder).replace(/\/$/, '')
    return compare(file).startsWith(`${compare(root)}/`)
  }).sort((a, b) => normalized(b.folder).length - normalized(a.folder).length)
  // Core can still find files outside a selected subfolder but inside its git repository.
  const project = matching[0] ?? projects[0]
  return project ? { project: project.project, file } : null
}
