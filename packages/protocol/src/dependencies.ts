// Looks up the ids a task depends on; unknown ids have none.
export type DependencyLookup = (taskId: string) => readonly string[]

// Adding `candidateId` to `taskId`'s dependencies closes a loop when the candidate
// already depends on the task, directly or through others.
export function createsCycle(lookup: DependencyLookup, taskId: string, candidateId: string): boolean {
  const seen = new Set<string>()
  const pending = [candidateId]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === taskId) {
      return true
    }
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...lookup(id))
    }
  }
  return false
}

export type DependencyBlocker = 'dependency-cycle'

export function checkDependencies(
  lookup: DependencyLookup,
  taskId: string,
  dependsOn: readonly string[]
): DependencyBlocker | null {
  return dependsOn.some((candidate) => createsCycle(lookup, taskId, candidate)) ? 'dependency-cycle' : null
}
