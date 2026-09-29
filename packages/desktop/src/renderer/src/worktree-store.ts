import { create } from 'zustand'
import type { ManagedWorktree, WorktreeCleanResult } from '@kando/protocol'
import { perform, useCore } from './core-store'

// null until core answers, and for an older core without worktrees.
export const useWorktrees = create<{ list: ManagedWorktree[] | null }>()(() => ({ list: null }))

// Tasks change in bursts (a run, its exit, a move), and each may change what can be cleaned.
const SETTLE_MS = 1500
// Nothing says when an agent fills a worktree, so the list is read again now and then.
const REFRESH_MS = 5 * 60 * 1000

let pending: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  const { rpc } = useCore.getState()
  if (!rpc?.features.includes('worktrees')) {
    useWorktrees.setState({ list: null })
    return
  }
  const list = await rpc.call('worktrees.list', {}).catch(() => null)
  if (list && useCore.getState().rpc === rpc) useWorktrees.setState({ list })
}

export function refreshWorktrees(delay = SETTLE_MS): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    void load()
  }, delay)
}

// Reads the list on each connection and when core says it changed, when tasks change, when the
// window comes back, and every few minutes.
export function startWorktreeUpdates(): void {
  useCore.subscribe((state, previous) => {
    if (state.rpc && state.rpc !== previous.rpc) {
      state.rpc.on('worktrees.changed', () => refreshWorktrees(0))
      refreshWorktrees(0)
    } else if (state.tasks !== previous.tasks) {
      refreshWorktrees()
    }
  })
  window.addEventListener('focus', () => refreshWorktrees(0))
  setInterval(() => refreshWorktrees(0), REFRESH_MS)
}

export async function cleanWorktrees(paths: readonly string[]): Promise<WorktreeCleanResult[] | null> {
  const results = await perform((rpc) => rpc.call('worktrees.clean', { paths: [...paths] }))
  await load()
  return results
}
