import path from 'node:path'
import { gitOrNull } from './git-changes'

const MAX_MATCHES = 20

// Files under these folders that a name refers to: the name as written, or the tail of a longer
// path. Only what git knows or would add (tracked, or untracked and not ignored), so node_modules
// and build output stay out. The shallowest match comes first: `src/a.json` over `src/x/y/a.json`.
export async function findFiles(roots: readonly string[], name: string): Promise<string[]> {
  const tail = name.replace(/^\.\//, '').replace(/^\/+/, '')
  if (!tail) return []
  const found = await Promise.all(roots.map(async (root) => {
    const listed = await gitOrNull(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (listed === null) return []
    return listed.split('\0')
      .filter((file) => file === tail || file.endsWith(`/${tail}`))
      .map((file) => path.join(root, file))
  }))
  const unique = [...new Set(found.flat())]
  return unique
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_MATCHES)
}
