import { useEffect } from 'react'
import { create } from 'zustand'
import { isBrowserTool, type BrowserTab } from '@kando/protocol'
import { useCore } from './core-store'
import { usePreferences } from './preferences'

// Browser tabs as core reports them while a view watches: a conversation's under its id, the
// user's own under USER_TABS, every tab there is under ALL_TABS (the browser panel's scope); and
// which one each scope's live view shows.
type BrowserTabs = { tabs: BrowserTab[]; selectedId: string | null }
export const USER_TABS = 'user'
export const ALL_TABS = '*'
export const useBrowserTabs = create<Record<string, BrowserTabs>>()(() => ({}))

function scopeOf(conversationId: string | null): string {
  return conversationId ?? USER_TABS
}

// Every tab, grouped by owner, with the scope of all kept in step.
function withAll(state: Record<string, BrowserTabs>): Record<string, BrowserTabs> {
  const all = Object.entries(state).filter(([key]) => key !== ALL_TABS).flatMap(([, each]) => each.tabs)
  const awaited = wantedAmong(all)
  if (awaited) wanted = null
  const next = selectAfter(state[ALL_TABS], all)
  return { ...state, [ALL_TABS]: awaited ? { ...next, selectedId: awaited.id } : next }
}

// The selection stays where it was while that tab is open; otherwise the one the agent last used,
// else the newest.
export function selectAfter(current: BrowserTabs | undefined, tabs: readonly BrowserTab[]): BrowserTabs {
  const kept = current?.selectedId && tabs.some((tab) => tab.id === current.selectedId) ? current.selectedId : null
  return { tabs: [...tabs], selectedId: kept ?? tabs.find((tab) => tab.active)?.id ?? tabs.at(-1)?.id ?? null }
}

export function receiveBrowserTabs(conversationId: string | null, tabs: readonly BrowserTab[]): void {
  const scope = scopeOf(conversationId)
  useBrowserTabs.setState((s) => withAll({ ...s, [scope]: selectAfter(s[scope], tabs) }))
}

// Everything at once, as watchAll answers: each owner's tabs replace what was known of them.
export function receiveAllBrowserTabs(tabs: readonly BrowserTab[]): void {
  useBrowserTabs.setState((s) => {
    const next: Record<string, BrowserTabs> = {}
    for (const key of Object.keys(s)) if (key !== ALL_TABS) next[key] = selectAfter(s[key], [])
    for (const tab of tabs) {
      const scope = scopeOf(tab.conversationId)
      next[scope] = selectAfter(s[scope], [...(next[scope]?.tabs ?? []), tab])
    }
    return withAll({ ...next, ...(s[ALL_TABS] ? { [ALL_TABS]: s[ALL_TABS] } : {}) })
  })
}

// scope: a conversation's id, or ALL_TABS for the browser panel.
export function selectBrowserTab(scope: string, tabId: string | null): void {
  useBrowserTabs.setState((s) => ({ [scope]: { tabs: s[scope]?.tabs ?? [], selectedId: tabId } }))
}

const NO_TABS: BrowserTabs = { tabs: [], selectedId: null }

// What the panel should show once it knows the tabs: a conversation's own, or one tab by id,
// asked for before the list has arrived (the panel just opened, or the tab is being made).
let wanted: { conversationId: string } | { tabId: string } | null = null

function wantedAmong(tabs: readonly BrowserTab[]): BrowserTab | undefined {
  if (!wanted) return undefined
  if ('tabId' in wanted) {
    const id = wanted.tabId
    return tabs.find((tab) => tab.id === id)
  }
  const conversationId = wanted.conversationId
  const own = tabs.filter((tab) => tab.conversationId === conversationId)
  return own.find((tab) => tab.active) ?? own.at(-1)
}

function focus(want: NonNullable<typeof wanted>): void {
  wanted = want
  const found = wantedAmong(useBrowserTabs.getState()[ALL_TABS]?.tabs ?? [])
  if (found) {
    wanted = null
    selectBrowserTab(ALL_TABS, found.id)
  }
}

export function focusBrowserConversation(conversationId: string): void {
  focus({ conversationId })
}

export function focusBrowserTab(tabId: string): void {
  focus({ tabId })
}

// Follows every tab while the browser panel is up.
export function useWatchAllBrowser(): BrowserTabs {
  const rpc = useCore((s) => s.rpc)
  useEffect(() => {
    if (!rpc) return
    let live = true
    void rpc.call('browser.watchAll', {}).then((tabs) => {
      if (live) receiveAllBrowserTabs(tabs)
    }).catch(() => {})
    return () => {
      live = false
      void rpc.call('browser.unwatchAll', {}).catch(() => {})
    }
  }, [rpc])
  return useBrowserTabs((s) => s[ALL_TABS]) ?? NO_TABS
}

// The key of the first browser call under way, or null: the panel opens on it, once.
export function firstBrowserCall(items: readonly { kind: string; name?: string; status?: string; stageId: string; id: string }[]): string | null {
  const found = items.find((item) => item.kind === 'tool' && item.name !== undefined && isBrowserTool(item.name) && item.status === 'running')
  return found ? `${found.stageId}/${found.id}` : null
}

// Whether the panel should open on its own for that call, as the user prefers.
export function shouldOpenBrowser(): boolean {
  return usePreferences.getState().openBrowserOnTab
}
