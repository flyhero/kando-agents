import { DEFAULT_INSTANCE, type SourceDescriptor, type SourceInbox } from '@kando/protocol'

export const inboxKey = (inbox: Pick<SourceInbox, 'provider' | 'instance'>) => `${inbox.provider}/${inbox.instance}`

export type ActiveInbox = { key: string; inbox: SourceInbox; name: string }

// The inboxes that are set up and signed in, in the order their sources are listed.
export function activeInboxes(sources: readonly SourceDescriptor[] | null, inboxes: Readonly<Record<string, SourceInbox>>): ActiveInbox[] {
  return (sources ?? []).flatMap((source) =>
    source.instances.flatMap((entry) => {
      const key = inboxKey({ provider: source.provider, instance: entry.instance })
      const inbox = inboxes[key]
      const name = entry.instance === DEFAULT_INSTANCE ? source.name : `${source.name} · ${entry.instance}`
      return inbox?.active ? [{ key, inbox, name }] : []
    })
  )
}

// The tab asked for while it is still there; otherwise the first with work waiting, then the first.
export function inboxTab(active: readonly ActiveInbox[], wanted: string | null): string | null {
  const chosen = active.find((entry) => entry.key === wanted) ?? active.find((entry) => entry.inbox.items.length > 0) ?? active[0]
  return chosen?.key ?? null
}
