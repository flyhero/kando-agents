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
  const match = /^((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w.@+-]+)(?::(\d+)(?::\d+)?)?$/.exec(text.trim())
  const path = match?.[1]
  if (!path) return null
  const extension = path.includes('.') ? path.split('.').at(-1)?.toLowerCase() : undefined
  // An absolute path names a file whatever it ends in.
  if (!(extension && EXTENSIONS.has(extension)) && !path.startsWith('/')) return null
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
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return [path]
  return [...new Set(roots.map((root) => joined(root, path)))]
}
