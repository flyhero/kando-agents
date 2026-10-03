import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { MAX_FILE_MATCHES, type ProjectFileMatch } from '@kando/protocol'
import { gitOrNull } from './git-changes'

const MAX_MATCHES = 20
// Each keystroke in the @ menu asks again; a listing this fresh is answered from memory.
const LISTING_TTL_MS = 5_000
// A folder git does not know is walked, but only so far.
const MAX_WALKED = 5_000
const UNWALKED = new Set(['node_modules'])

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

type Listing = { files: string[]; directories: string[] }
const listings = new Map<string, { at: number; listing: Promise<Listing> }>()

// The files and folders of each root that fuzzily match `query`, best first: the query starting a
// name, then inside a name, then inside the path, then its letters spread along a name in order
// (along the whole path, nearly everything would match); within each, the shallowest and shortest. An empty query gives each root's top level, folders first.
export async function searchFiles(roots: readonly string[], query: string): Promise<ProjectFileMatch[]> {
  const needle = query.trim().replace(/^\.\//, '').toLowerCase()
  const found = await Promise.all(roots.map(async (root) => {
    const { files, directories } = await listingOf(root)
    const entries = [
      ...directories.map((relative) => ({ relative, kind: 'directory' as const })),
      ...files.map((relative) => ({ relative, kind: 'file' as const }))
    ]
    return entries.flatMap((entry) => {
      const tier = needle ? matchTier(entry.relative.toLowerCase(), needle) : entry.relative.includes('/') ? null : entry.kind === 'directory' ? 0 : 1
      return tier === null ? [] : [{ match: { path: path.join(root, entry.relative), root, relative: entry.relative, kind: entry.kind }, tier }]
    })
  }))
  const seen = new Set<string>()
  return found.flat()
    .sort((a, b) => a.tier - b.tier || depth(a.match.relative) - depth(b.match.relative)
      || a.match.relative.length - b.match.relative.length || a.match.relative.localeCompare(b.match.relative))
    .map((each) => each.match)
    .filter((match) => !seen.has(match.path) && seen.add(match.path))
    .slice(0, MAX_FILE_MATCHES)
}

function matchTier(relative: string, needle: string): number | null {
  const name = relative.slice(relative.lastIndexOf('/') + 1)
  if (name.startsWith(needle)) return 0
  if (name.includes(needle)) return 1
  if (relative.includes(needle)) return 2
  let at = 0
  for (const char of name) {
    if (char === needle[at]) at += 1
    if (at === needle.length) return 3
  }
  return null
}

function depth(relative: string): number {
  return relative.split('/').length
}

function listingOf(root: string): Promise<Listing> {
  const cached = listings.get(root)
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.listing
  const listing = listRoot(root)
  listings.set(root, { at: Date.now(), listing })
  listing.catch(() => listings.delete(root))
  return listing
}

// What git knows or would add, so ignored output stays out; a folder outside git is walked instead.
async function listRoot(root: string): Promise<Listing> {
  const listed = await gitOrNull(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const files = listed === null ? await walk(root) : listed.split('\0').filter(Boolean)
  const directories = new Set<string>()
  for (const file of files) {
    for (let slash = file.indexOf('/'); slash > 0; slash = file.indexOf('/', slash + 1)) directories.add(file.slice(0, slash))
  }
  return { files, directories: [...directories] }
}

// Breadth first, skipping dot folders and node_modules, so a huge folder still lists its top.
async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  let seen = 0
  for (let folder = queue.shift(); folder !== undefined && seen < MAX_WALKED; folder = queue.shift()) {
    const entries = await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || seen >= MAX_WALKED) continue
      seen += 1
      const relative = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!UNWALKED.has(entry.name)) queue.push(relative)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }
  return files
}
