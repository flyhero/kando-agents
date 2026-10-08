// Which inline code in a reply names a file, and where that file may be.

// What agents write file names with; a name with another extension, or none, is likely not a file
// (module.exports, v1.2.3, origin/main).
const EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'yml', 'yaml', 'toml', 'ini', 'sh', 'bash', 'zsh', 'sql', 'xml', 'gradle', 'txt', 'lock', 'proto',
  'graphql', 'dart', 'lua', 'ex', 'exs', 'env', 'properties', 'conf'
])

export type FileReference = { path: string; line: number | null }

export function fileReference(text: string): FileReference | null {
  const match = /^((?:[a-zA-Z]:[\\/]|[\\/]{2}|(?:~|\.{1,2})?[\\/]?)?(?:[\p{L}\p{N}_.@+ -]+[\\/])*[\p{L}\p{N}_.@+ -]+)(?::(\d+)(?::\d+)?)?$/u.exec(text.trim())
  const path = match?.[1]
  if (!path) return null
  const extension = path.includes('.') ? path.split('.').at(-1)?.toLowerCase() : undefined
  // An absolute path names a file whatever it ends in.
  if (!(extension && EXTENSIONS.has(extension)) && !path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith('\\\\')) return null
  return { path, line: match[2] ? Number(match[2]) : null }
}

// Joins a relative path onto a folder, resolving . and .. as a shell would.
function joined(root: string, relative: string): string {
  const parts = root.split('/')
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/') || '/'
}

// Where a named file may be: as written when absolute or under home, else under each of the
// conversation's folders, the primary one first.
export function fileCandidates(path: string, roots: readonly string[]): string[] {
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path === '~' || /^~[\\/]/.test(path)) return [path]
  return [...new Set(roots.map((root) => joined(root, path)))]
}

// What a link in a reply leads to: a page for the browser, or a file on this machine. Anything
// else (mailto:, an anchor, an app's own scheme) is neither.
export type LinkTarget = { kind: 'web'; href: string } | ({ kind: 'file' } & FileReference)

export function linkTarget(href: string): LinkTarget | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'web', href }
  let path = href
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      path = (url.host ? `//${url.host}${url.pathname}` : url.pathname) + url.hash
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    } catch {
      return null
    }
  } else if (href.startsWith('#') || (/^[a-z][a-z\d+.-]*:(?!\d+(?::\d+)?$)/i.test(href) && !/^[a-z]:[\\/]/i.test(href))) {
    // A scheme, unless it is a drive letter or the colon only starts a line number (a.ts:12).
    return null
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // A stray % is part of the name.
  }
  // Agents point at a line as file.ts:12 or as GitHub does, file.ts#L12.
  const line = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(path)
  if (line) path = path.slice(0, line.index)
  return path ? { kind: 'file', path, line: line ? Number(line[1] ?? line[2]) : null } : null
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(path.split('.').at(-1)?.toLowerCase() ?? '')
}

// main's kando-preview protocol reads the file at the URL's path; each part is escaped so a # or
// a space stays part of the name.
export function previewUrl(path: string): string {
  return `kando-preview://file${path.split('/').map(encodeURIComponent).join('/')}`
}
