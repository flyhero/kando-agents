import type { Conversation, RpcConnection } from '@kando/protocol'

export type AttentionSummaryMode = 'complete' | 'limited'

export function attentionSummaryMode(rpc: Pick<RpcConnection, 'features'>): AttentionSummaryMode {
  return rpc.features.includes('task-conversation-summaries') ? 'complete' : 'limited'
}

// Notifications newer than the list response win, including deletions during a load.
export function replaySummaryChanges<T extends { id: string }>(items: readonly T[], changes: ReadonlyMap<string, T | null>): Record<string, T> {
  const result = Object.fromEntries(items.map((item) => [item.id, item]))
  for (const [id, item] of changes) {
    if (item) result[id] = item
    else delete result[id]
  }
  return result
}

export async function fetchAttentionSummaries(rpc: RpcConnection): Promise<Record<string, Conversation>> {
  const changes = new Map<string, Conversation | null>()
  const offChanged = rpc.on('conversations.changed', ({ conversation }) => changes.set(conversation.id, conversation))
  const offDeleted = rpc.on('conversations.deleted', ({ id }) => changes.set(id, null))
  try {
    const items = await rpc.call('conversations.list', attentionSummaryMode(rpc) === 'complete' ? { includeTasks: true } : {})
    return replaySummaryChanges(items, changes)
  } finally {
    offChanged()
    offDeleted()
  }
}
