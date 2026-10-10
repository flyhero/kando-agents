// A name git log decorates a commit with (%D): "HEAD -> main", "origin/main", "tag: v1", "HEAD".
export type CommitRef = { name: string; kind: 'local' | 'remote' | 'tag' | 'head'; current: boolean }

const ORDER: Record<CommitRef['kind'], number> = { head: 0, local: 1, remote: 2, tag: 3 }

// A remote's branch is told from a local one by the remote's name before its slash, since a local
// branch may have a slash of its own (fix/slow-sql).
export function commitRefs(decorations: readonly string[], remotes: readonly string[]): CommitRef[] {
  const refs = decorations.map((decoration): CommitRef => {
    if (decoration === 'HEAD') return { name: 'HEAD', kind: 'head', current: true }
    if (decoration.startsWith('HEAD -> ')) return { name: decoration.slice('HEAD -> '.length), kind: 'local', current: true }
    if (decoration.startsWith('tag: ')) return { name: decoration.slice('tag: '.length), kind: 'tag', current: false }
    const remote = remotes.some((name) => decoration.startsWith(`${name}/`))
    return { name: decoration, kind: remote ? 'remote' : 'local', current: false }
  })
  // The checked-out branch first, then local branches, remote ones and tags, each as git listed them.
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => Number(b.ref.current) - Number(a.ref.current) || ORDER[a.ref.kind] - ORDER[b.ref.kind] || a.index - b.index)
    .map(({ ref }) => ref)
}
