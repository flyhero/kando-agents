import { create } from 'zustand'
import type { ResolvedFile } from '@kando/protocol'

export type FileTab = { file: ResolvedFile; line: number | null; reveal: number; scrollTop: number; scrollLeft: number }
export type FileTabs = { tabs: FileTab[]; active: string | null; wrap: boolean; maximized: boolean }
export const EMPTY_FILE_TABS: FileTabs = { tabs: [], active: null, wrap: true, maximized: false }
export const useFileTabs = create<Record<string, FileTabs>>()(() => ({}))

export function openedFile(state: FileTabs, file: ResolvedFile, line: number | null): FileTabs {
  const existing = state.tabs.find((tab) => tab.file.path === file.path)
  const tab: FileTab = { file, line, reveal: (existing?.reveal ?? 0) + 1, scrollTop: existing?.scrollTop ?? 0, scrollLeft: existing?.scrollLeft ?? 0 }
  return { ...state, active: file.path, tabs: existing ? state.tabs.map((each) => each.file.path === file.path ? tab : each) : [...state.tabs, tab] }
}

export function closedFile(state: FileTabs, path: string): FileTabs {
  const index = state.tabs.findIndex((tab) => tab.file.path === path)
  const tabs = state.tabs.filter((tab) => tab.file.path !== path)
  return { ...state, tabs, active: state.active === path ? (tabs[Math.min(index, tabs.length - 1)]?.file.path ?? null) : state.active, maximized: tabs.length > 0 && state.maximized }
}

export function updateFileTabs(id: string, change: (state: FileTabs) => FileTabs): void {
  if (!id) return
  useFileTabs.setState((state) => {
    const before = state[id] ?? EMPTY_FILE_TABS
    const next = change(before)
    return next === before ? state : { [id]: next }
  })
}

export function forgetFileTabs(id: string): void {
  const { [id]: _deleted, ...kept } = useFileTabs.getState()
  useFileTabs.setState(kept, true)
}

export function saveFileScroll(id: string, path: string, scrollTop: number, scrollLeft: number): void {
  updateFileTabs(id, (state) => state.tabs.some((tab) => tab.file.path === path && (tab.scrollTop !== scrollTop || tab.scrollLeft !== scrollLeft))
    ? { ...state, tabs: state.tabs.map((tab) => tab.file.path === path ? { ...tab, scrollTop, scrollLeft } : tab) } : state)
}
